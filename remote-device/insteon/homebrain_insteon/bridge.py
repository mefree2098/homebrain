"""Core bridge logic managing the PLM connection and device registry."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

try:  # pyinsteon is optional for documentation builds
    from pyinsteon import async_connect
except Exception:  # pragma: no cover - library missing in dev env
    async_connect = None  # type: ignore

from .config import BridgeConfig
from .devices import device_to_snapshot, snapshot_collection


class BridgeNotConnected(Exception):
    """Raised when an operation requires an active PLM connection."""


class DeviceNotFoundError(Exception):
    """Raised when a requested device is not known to the bridge."""


class InsteonBridge:
    """Manages the Insteon PLM lifecycle and exposes device operations."""

    def __init__(self, config: Optional[BridgeConfig] = None, *, loop: Optional[asyncio.AbstractEventLoop] = None):
        self.config = config or BridgeConfig.from_env()
        self.loop = loop or asyncio.get_event_loop()
        self.log = logging.getLogger("homebrain.insteon.bridge")
        self.log.setLevel(self.config.log_level.upper())

        self._modem: Any = None
        self._connection: Any = None

        self._connect_task: Optional[asyncio.Task] = None
        self._event_dispatch_task: Optional[asyncio.Task] = None
        self._stop_event = asyncio.Event()
        self._connected_event = asyncio.Event()

        self._status: Dict[str, Any] = {
            "connected": False,
            "port": self.config.serial_port,
            "connect_attempts": 0,
            "successful_connects": 0,
            "last_error": None,
            "device_count": 0,
            "last_discovery": None,
        }

        self._device_cache: Dict[str, Dict[str, Any]] = {}
        self._discovery_lock = asyncio.Lock()
        self._device_cache_lock = asyncio.Lock()

        self._event_queue: "asyncio.Queue[Dict[str, Any]]" = asyncio.Queue(self.config.websocket_event_buffer)
        self._ws_clients: List[Any] = []  # WebSocketResponse objects

        self._load_cached_devices()

    # ------------------------------------------------------------------
    # Lifecycle management
    # ------------------------------------------------------------------
    async def start(self) -> None:
        if self._connect_task is not None:
            return
        self._stop_event.clear()
        self._connect_task = self.loop.create_task(self._connect_loop(), name="insteon-connect")
        self._event_dispatch_task = self.loop.create_task(self._event_dispatch_loop(), name="insteon-events")
        self.log.info("Insteon bridge started (port=%s)", self.config.serial_port)

    async def stop(self) -> None:
        self._stop_event.set()
        tasks = [t for t in (self._connect_task, self._event_dispatch_task) if t]
        for task in tasks:
            task.cancel()
        if self._connection:
            try:
                await asyncio.wait_for(self._connection.close(), timeout=5)
            except Exception:
                pass
        self._connection = None
        self._modem = None
        self._connected_event.clear()
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self.log.info("Insteon bridge stopped")

    async def wait_until_connected(self, timeout: Optional[float] = None) -> bool:
        try:
            await asyncio.wait_for(self._connected_event.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    # ------------------------------------------------------------------
    async def _connect_loop(self) -> None:
        if async_connect is None:
            self.log.warning("pyinsteon not installed; running in offline mode")
            await self._publish_event({"type": "bridge_status", "connected": False, "note": "pyinsteon missing"})
            return

        base_backoff = self.config.reconnect_initial
        max_backoff = self.config.reconnect_max
        backoff = base_backoff

        while not self._stop_event.is_set():
            self._status["connect_attempts"] += 1
            sleep_delay = base_backoff
            try:
                self.log.info("Connecting to Insteon PLM on %s (attempt %s)", self.config.serial_port, self._status["connect_attempts"])
                modem, connection = await async_connect(device=self.config.serial_port)
                self._modem, self._connection = modem, connection
                self._status["connected"] = True
                self._status["successful_connects"] += 1
                self._status["last_error"] = None
                self._connected_event.set()
                backoff = base_backoff
                sleep_delay = 0.0
                await self._publish_event({"type": "bridge_status", "connected": True, "port": self.config.serial_port})
                self.log.info("Connected to PLM; known devices: %s", len(getattr(modem, "devices", {})))
                await self._stop_event.wait()
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self._status["connected"] = False
                self._connected_event.clear()
                self._status["last_error"] = f"{type(exc).__name__}: {exc}"
                self.log.warning("PLM connect failed: %s", self._status["last_error"])
                await self._publish_event({
                    "type": "bridge_status",
                    "connected": False,
                    "error": self._status["last_error"],
                })
                sleep_delay = backoff
            finally:
                if self._connection:
                    try:
                        await asyncio.wait_for(self._connection.close(), timeout=5)
                    except Exception:
                        pass
                self._connection = None
                self._modem = None
                self._connected_event.clear()
                self._status["connected"] = False
                if self._stop_event.is_set():
                    break
                if sleep_delay > 0:
                    await asyncio.sleep(sleep_delay)
                    backoff = min(max_backoff, max(base_backoff, sleep_delay * 2))
                else:
                    backoff = base_backoff

    async def _event_dispatch_loop(self) -> None:
        try:
            while not self._stop_event.is_set():
                event = await self._event_queue.get()
                await self._broadcast(event)
        except asyncio.CancelledError:
            return

    # ------------------------------------------------------------------
    # Discovery and device registry
    # ------------------------------------------------------------------
    async def run_discovery(self, refresh: Optional[bool] = None) -> Dict[str, Any]:
        refresh = self.config.discovery_refresh_default if refresh is None else refresh
        if not self._modem:
            if self.config.allow_mock_mode:
                self.log.info("Discovery requested in mock mode; returning cached devices only")
                async with self._device_cache_lock:
                    devices = list(self._device_cache.values())
                return {"devices": devices, "mode": "mock"}
            raise BridgeNotConnected("PLM not connected")

        async with self._discovery_lock:
            try:
                devices_container = getattr(self._modem, "devices", None)
                if devices_container is None:
                    raise RuntimeError("pyinsteon modem has no devices container")
                load_coro = getattr(devices_container, "async_load", None)
                if callable(load_coro):
                    await load_coro(refresh=refresh)
                else:
                    load_fn = getattr(devices_container, "load", None)
                    if callable(load_fn):
                        await asyncio.to_thread(load_fn, refresh=refresh)
                device_iterable: Iterable[Any]
                if hasattr(devices_container, "values"):
                    device_iterable = devices_container.values()
                else:
                    device_iterable = list(devices_container)
                snapshots = snapshot_collection(device_iterable)
                async with self._device_cache_lock:
                    self._device_cache = {item["id"]: item for item in snapshots}
                    self._status["device_count"] = len(self._device_cache)
                    self._status["last_discovery"] = time.time()
                self._persist_device_cache()
                await self._publish_event({"type": "discovery_complete", "device_count": len(snapshots)})
                return {"devices": snapshots, "mode": "live", "count": len(snapshots)}
            except Exception as exc:
                self.log.exception("Discovery failed: %s", exc)
                raise

    async def list_devices(self) -> List[Dict[str, Any]]:
        if self._modem:
            try:
                devices_container = getattr(self._modem, "devices", None)
                if devices_container and hasattr(devices_container, "values"):
                    return snapshot_collection(devices_container.values())
            except Exception:
                self.log.debug("Failed to snapshot live devices; falling back to cache", exc_info=True)
        async with self._device_cache_lock:
            return list(self._device_cache.values())

    async def get_device(self, device_id: str) -> Dict[str, Any]:
        if not device_id:
            raise DeviceNotFoundError("Device id required")
        if self._modem:
            try:
                devices_container = getattr(self._modem, "devices", None)
                if devices_container and hasattr(devices_container, "get"):
                    device = devices_container.get(device_id)
                    if device:
                        return device_to_snapshot(device).to_dict()
                for device in getattr(devices_container, "values", lambda: [])():
                    snapshot = device_to_snapshot(device).to_dict()
                    if snapshot["id"].lower() == device_id.lower():
                        return snapshot
            except Exception:
                self.log.debug("Live device lookup failed; falling back to cache", exc_info=True)
        async with self._device_cache_lock:
            device = self._device_cache.get(device_id) or self._device_cache.get(device_id.lower())
            if device:
                return device
        raise DeviceNotFoundError(f"Insteon device {device_id} not found")

    # ------------------------------------------------------------------
    async def send_command(self, device_id: str, command: str, *, level: Optional[int] = None, fast: bool = False, duration: Optional[float] = None) -> Dict[str, Any]:
        if not self._modem:
            raise BridgeNotConnected("Cannot send command without PLM connection")
        devices_container = getattr(self._modem, "devices", None)
        target_device = None
        if devices_container and hasattr(devices_container, "get"):
            target_device = devices_container.get(device_id)
        if target_device is None and devices_container and hasattr(devices_container, "values"):
            for device in devices_container.values():
                snapshot = device_to_snapshot(device).to_dict()
                if snapshot["id"].lower() == device_id.lower():
                    target_device = device
                    break
        if target_device is None:
            raise DeviceNotFoundError(f"Insteon device {device_id} not found")

        original_level = level
        level_value = None
        if level is not None:
            try:
                level_int = int(level)
            except Exception as exc:
                raise ValueError(f"Invalid level value: {level}") from exc
            level_int = max(0, min(level_int, 255))
            if level_int <= 100:
                level_value = int(round((level_int / 100) * 255))
            else:
                level_value = level_int
        handler = self._resolve_command_handler(target_device, command, fast=fast)
        if handler is None:
            raise ValueError(f"Command '{command}' not supported by device {device_id}")

        self.log.info("Dispatching command=%s level=%s fast=%s -> %s", command, original_level, fast, device_id)
        kwargs: Dict[str, Any] = {}
        if level_value is not None:
            kwargs["level"] = level_value
        if duration is not None:
            kwargs["duration"] = duration
        try:
            result = handler(**kwargs)
            if asyncio.iscoroutine(result):
                await result
        except Exception as exc:
            self.log.exception("Command failed: %s", exc)
            raise

        payload = {
            "type": "command_ack",
            "device_id": device_id,
            "command": command,
            "level": original_level,
            "fast": fast,
        }
        await self._publish_event(payload)
        return payload

    def _resolve_command_handler(self, device: Any, command: str, *, fast: bool = False):
        command = command.lower()
        attr_candidates = []
        if command in {"on", "turn_on"}:
            attr_candidates.append("async_turn_on")
            if fast:
                attr_candidates.insert(0, "async_fast_on")
        elif command in {"off", "turn_off"}:
            attr_candidates.append("async_turn_off")
            if fast:
                attr_candidates.insert(0, "async_fast_off")
        elif command in {"fast_on", "fast-off", "fast_off"}:
            attr_candidates.extend(["async_fast_on", "fast_on", "async_fast_off", "fast_off"])
        elif command in {"status", "query", "ping"}:
            attr_candidates.extend(["async_status_request", "async_get_status", "async_query_status"])
        else:
            attr_candidates.append(f"async_{command}")
            attr_candidates.append(command)
        for attr in attr_candidates:
            handler = getattr(device, attr, None)
            if handler:
                return handler
        return None

    # ------------------------------------------------------------------
    def status_snapshot(self) -> Dict[str, Any]:
        status = dict(self._status)
        status["connected"] = bool(self._connected_event.is_set())
        status["ws_clients"] = len(self._ws_clients)
        last_disc = status.get("last_discovery")
        if isinstance(last_disc, (int, float)):
            status["last_discovery"] = datetime.fromtimestamp(last_disc).isoformat()
        return status

    # ------------------------------------------------------------------
    # Persistence helpers
    # ------------------------------------------------------------------
    def _load_cached_devices(self) -> None:
        path: Path = self.config.device_cache_path
        try:
            if path.is_file():
                with path.open("r", encoding="utf-8") as handle:
                    data = json.load(handle)
                devices = data.get("devices") if isinstance(data, dict) else data
                if isinstance(devices, list):
                    self._device_cache = {d["id"]: d for d in devices if isinstance(d, dict) and "id" in d}
                    self._status["device_count"] = len(self._device_cache)
                    self.log.info("Loaded %s cached Insteon devices from %s", len(self._device_cache), path)
        except Exception as exc:
            self.log.warning("Failed to load cached devices from %s: %s", path, exc)

    def _persist_device_cache(self) -> None:
        path: Path = self.config.device_cache_path
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            payload = {"devices": list(self._device_cache.values())}
            tmp_path = path.with_suffix(".tmp")
            with tmp_path.open("w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, sort_keys=True)
            tmp_path.replace(path)
            self.log.debug("Persisted %s devices to %s", len(self._device_cache), path)
        except Exception as exc:
            self.log.warning("Failed to persist device cache: %s", exc)

    # ------------------------------------------------------------------
    async def _publish_event(self, event: Dict[str, Any]) -> None:
        try:
            self._event_queue.put_nowait(event)
        except asyncio.QueueFull:
            self.log.warning("Dropping event because queue is full: %s", event.get("type"))

    async def _broadcast(self, event: Dict[str, Any]) -> None:
        if not self._ws_clients:
            return
        stale_clients: List[Any] = []
        for ws in list(self._ws_clients):
            try:
                await ws.send_json(event)
            except Exception:
                stale_clients.append(ws)
        for ws in stale_clients:
            try:
                self._ws_clients.remove(ws)
            except ValueError:
                pass

    def attach_ws_client(self, ws: Any) -> None:
        self._ws_clients.append(ws)

    def detach_ws_client(self, ws: Any) -> None:
        try:
            self._ws_clients.remove(ws)
        except ValueError:
            pass


__all__ = [
    "InsteonBridge",
    "BridgeNotConnected",
    "DeviceNotFoundError",
]
