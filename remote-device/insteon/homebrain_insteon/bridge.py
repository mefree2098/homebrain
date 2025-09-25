"""Core bridge logic managing the PLM connection and device registry."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple

try:  # pyinsteon is optional for documentation builds
    from pyinsteon import async_connect
    from pyinsteon.constants import DeviceAction
except Exception:  # pragma: no cover - library missing in dev env
    async_connect = None  # type: ignore
    DeviceAction = None  # type: ignore

from .config import BridgeConfig
from .devices import device_to_snapshot


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

        self._device_manager: Any = None
        self._modem: Any = None

        self._manager_subscription: Optional[Callable[..., None]] = None
        self._device_callbacks: Dict[str, List[Tuple[Any, Callable[..., None]]]] = {}
        self._device_objects: Dict[str, Any] = {}

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
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        await self._cleanup_after_disconnect()
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
                manager = await async_connect(device=self.config.serial_port)
                await self._on_connected(manager)
                backoff = base_backoff
                sleep_delay = 0.0
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
                await self._cleanup_after_disconnect()
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
    async def _on_connected(self, manager: Any) -> None:
        self._device_manager = manager
        self._modem = getattr(manager, "modem", None)
        self._status["connected"] = True
        self._status["successful_connects"] += 1
        self._status["last_error"] = None
        self._connected_event.set()

        if hasattr(manager, "subscribe"):
            self._manager_subscription = self._handle_device_manager_event
            try:
                manager.subscribe(self._manager_subscription, force_strong_ref=True)
            except Exception:
                self._manager_subscription = None

        await self._publish_event({
            "type": "bridge_status",
            "connected": True,
            "port": self.config.serial_port,
        })

        await self._prime_device_cache(manager)

    async def _cleanup_after_disconnect(self) -> None:
        manager = self._device_manager
        modem = self._modem
        subscription = self._manager_subscription

        if manager and subscription and hasattr(manager, "unsubscribe"):
            with suppress(Exception):
                manager.unsubscribe(subscription)
        self._manager_subscription = None

        self._clear_device_callbacks()
        self._device_objects.clear()

        was_connected = self._connected_event.is_set()
        self._device_manager = None
        self._modem = None
        self._connected_event.clear()
        self._status["connected"] = False

        if manager and hasattr(manager, "async_close"):
            with suppress(Exception):
                await asyncio.wait_for(manager.async_close(), timeout=5)
        if modem and hasattr(modem, "async_close"):
            with suppress(Exception):
                await asyncio.wait_for(modem.async_close(), timeout=5)

        if was_connected:
            await self._publish_event({
                "type": "bridge_status",
                "connected": False,
                "port": self.config.serial_port,
            })

    async def _prime_device_cache(self, manager: Any) -> None:
        snapshots: List[Dict[str, Any]] = []
        devices_iterable: Iterable[Any] = []
        try:
            values = getattr(manager, "values", None)
            if callable(values):
                devices_iterable = list(values())
        except Exception:
            devices_iterable = []

        for device in devices_iterable:
            if self._modem and device is self._modem:
                continue
            snapshot = await self._register_device(device, persist=False)
            if snapshot:
                snapshots.append(snapshot)

        if snapshots:
            async with self._device_cache_lock:
                self._status["device_count"] = len(self._device_cache)
                self._status["last_discovery"] = time.time()
            self._persist_device_cache()
            await self._publish_event({
                "type": "device_snapshot",
                "count": len(snapshots),
                "devices": snapshots,
            })
        self.log.info("Connected to PLM; known devices: %s", len(snapshots))

    async def _register_device(self, device: Any, *, persist: bool = True) -> Optional[Dict[str, Any]]:
        snapshot = await self._update_cached_device(device, persist=persist)
        device_id = snapshot.get("id") if snapshot else None
        if not device_id:
            return snapshot

        await self._unregister_device(device_id, drop=False)

        callbacks: List[Tuple[Any, Callable[..., None]]] = []

        events = getattr(device, "events", {}) or {}
        if isinstance(events, dict):
            for group_events in events.values():
                if not isinstance(group_events, dict):
                    continue
                for event_name, event_obj in group_events.items():
                    if not hasattr(event_obj, "subscribe"):
                        continue
                    callback = self._make_event_callback(device_id, event_name)
                    try:
                        event_obj.subscribe(callback, force_strong_ref=True)
                        callbacks.append((event_obj, callback))
                    except Exception:
                        self.log.debug("Failed to subscribe to %s event on %s", event_name, device_id, exc_info=True)

        groups = getattr(device, "groups", {}) or {}
        if isinstance(groups, dict):
            for group in groups.values():
                if not hasattr(group, "subscribe"):
                    continue
                group_name = getattr(group, "name", "state")
                callback = self._make_group_callback(device_id, group_name)
                try:
                    group.subscribe(callback, force_strong_ref=True)
                    callbacks.append((group, callback))
                except Exception:
                    self.log.debug("Failed to subscribe to group %s on %s", group_name, device_id, exc_info=True)

        if callbacks:
            self._device_callbacks[device_id] = callbacks

        return snapshot

    async def _unregister_device(self, device_id: str, *, drop: bool) -> None:
        callbacks = self._device_callbacks.pop(device_id, [])
        for source, callback in callbacks:
            if hasattr(source, "unsubscribe"):
                with suppress(Exception):
                    source.unsubscribe(callback)
        if drop:
            self._device_objects.pop(device_id, None)
            removed = None
            async with self._device_cache_lock:
                removed = self._device_cache.pop(device_id, None)
                self._status["device_count"] = len(self._device_cache)
            if removed is not None:
                self._persist_device_cache()

    async def _update_cached_device(self, device: Any, *, persist: bool = True) -> Dict[str, Any]:
        snapshot = device_to_snapshot(device).to_dict()
        device_id = snapshot.get("id")
        if not device_id:
            return snapshot
        normalized = self._normalize_device_id(device_id)
        snapshot["id"] = normalized
        snapshot["address"] = normalized
        self._device_objects[normalized] = device
        async with self._device_cache_lock:
            self._device_cache[normalized] = snapshot
            self._status["device_count"] = len(self._device_cache)
        if persist:
            self._persist_device_cache()
        return snapshot

    def _clear_device_callbacks(self) -> None:
        for source, callback in [item for callbacks in self._device_callbacks.values() for item in callbacks]:
            if hasattr(source, "unsubscribe"):
                with suppress(Exception):
                    source.unsubscribe(callback)
        self._device_callbacks.clear()

    def _make_event_callback(self, device_id: str, event_name: str) -> Callable[..., None]:
        def handler(name: str, address: str, group: int, button: str = "", **_: Any) -> None:
            payload = {
                "device_id": self._normalize_device_id(device_id),
                "event": name or event_name,
                "group": group,
                "button": button or None,
            }
            self.loop.call_soon_threadsafe(self._handle_device_event_notification, payload)

        return handler

    def _make_group_callback(self, device_id: str, group_name: str) -> Callable[..., None]:
        def handler(name: str, address: str, value: Any, group: int, **_: Any) -> None:
            payload = {
                "device_id": self._normalize_device_id(device_id),
                "name": name or group_name,
                "group": group,
                "value": value,
            }
            self.loop.call_soon_threadsafe(self._handle_group_notification, payload)

        return handler

    def _handle_device_manager_event(self, **payload: Any) -> None:
        if DeviceAction is None:
            return
        action = payload.get("action")
        address = payload.get("address")
        if not address:
            return
        normalized = self._normalize_device_id(address)
        if action == DeviceAction.ADDED:
            self.loop.create_task(self._handle_device_added(normalized))
        elif action == DeviceAction.REMOVED:
            self.loop.create_task(self._handle_device_removed(normalized))

    async def _handle_device_added(self, device_id: str) -> None:
        device = self._find_device_by_id(device_id)
        if not device:
            return
        snapshot = await self._register_device(device, persist=True)
        await self._publish_event({
            "type": "device_added",
            "device": snapshot,
        })

    async def _handle_device_removed(self, device_id: str) -> None:
        await self._unregister_device(device_id, drop=True)
        await self._publish_event({
            "type": "device_removed",
            "device_id": device_id,
        })

    def _handle_device_event_notification(self, payload: Dict[str, Any]) -> None:
        self.loop.create_task(self._process_device_event(payload))

    def _handle_group_notification(self, payload: Dict[str, Any]) -> None:
        self.loop.create_task(self._process_group_event(payload))

    async def _process_device_event(self, payload: Dict[str, Any]) -> None:
        device_id = payload.get("device_id")
        if not device_id:
            return
        device = self._device_objects.get(device_id) or self._find_device_by_id(device_id)
        snapshot = None
        if device:
            snapshot = await self._update_cached_device(device, persist=False)
        event_payload = {"type": "device_event", **payload}
        if snapshot:
            event_payload["device"] = snapshot
        await self._publish_event(event_payload)

    async def _process_group_event(self, payload: Dict[str, Any]) -> None:
        device_id = payload.get("device_id")
        if not device_id:
            return
        device = self._device_objects.get(device_id) or self._find_device_by_id(device_id)
        snapshot = None
        if device:
            snapshot = await self._update_cached_device(device, persist=False)
        state_payload = {"type": "device_state", **payload}
        if snapshot:
            state_payload["device"] = snapshot
        await self._publish_event(state_payload)

    def _find_device_by_id(self, device_id: str) -> Optional[Any]:
        normalized = self._normalize_device_id(device_id)
        if normalized in self._device_objects:
            return self._device_objects[normalized]
        manager = self._device_manager
        if not manager or not hasattr(manager, "values"):
            return None
        with suppress(Exception):
            for device in manager.values():
                address = getattr(device, "address", None)
                candidate = getattr(address, "id", None)
                if candidate and self._normalize_device_id(candidate) == normalized:
                    return device
        return None

    @staticmethod
    def _normalize_device_id(address: str) -> str:
        return str(address).replace(".", "").replace(":", "").lower()

    # ------------------------------------------------------------------
    # Discovery and device registry
    # ------------------------------------------------------------------
    async def run_discovery(self, refresh: Optional[bool] = None) -> Dict[str, Any]:
        refresh = self.config.discovery_refresh_default if refresh is None else refresh
        manager = self._device_manager
        if not manager:
            if self.config.allow_mock_mode:
                self.log.info("Discovery requested in mock mode; returning cached devices only")
                async with self._device_cache_lock:
                    devices = list(self._device_cache.values())
                return {"devices": devices, "mode": "mock"}
            raise BridgeNotConnected("PLM not connected")

        async with self._discovery_lock:
            try:
                load_fn = getattr(manager, "async_load", None)
                if callable(load_fn):
                    kwargs: Dict[str, Any] = {}
                    if refresh:
                        kwargs = {"id_devices": 2, "load_modem_aldb": 2}
                    await load_fn(**kwargs)
            except Exception as exc:
                self.log.exception("Discovery failed: %s", exc)
                raise
            devices_iterable: Iterable[Any] = []
            try:
                values = getattr(manager, "values", None)
                if callable(values):
                    devices_iterable = list(values())
            except Exception:
                devices_iterable = []
            snapshots: List[Dict[str, Any]] = []
            for device in devices_iterable:
                if self._modem and device is self._modem:
                    continue
                snapshot = await self._register_device(device, persist=False)
                if snapshot:
                    snapshots.append(snapshot)
            async with self._device_cache_lock:
                self._status["device_count"] = len(self._device_cache)
                self._status["last_discovery"] = time.time()
            self._persist_device_cache()
            await self._publish_event({
                "type": "discovery_complete",
                "device_count": len(snapshots),
                "devices": snapshots,
                "mode": "live",
            })
            return {"devices": snapshots, "mode": "live", "count": len(snapshots)}

    async def list_devices(self) -> List[Dict[str, Any]]:
        manager = self._device_manager
        if manager:
            try:
                values = getattr(manager, "values", None)
                if callable(values):
                    snapshots: List[Dict[str, Any]] = []
                    for device in list(values()):
                        if self._modem and device is self._modem:
                            continue
                        snapshots.append(await self._update_cached_device(device, persist=False))
                    return snapshots
            except Exception:
                self.log.debug("Failed to snapshot live devices; falling back to cache", exc_info=True)
        async with self._device_cache_lock:
            return list(self._device_cache.values())

    async def get_device(self, device_id: str) -> Dict[str, Any]:
        if not device_id:
            raise DeviceNotFoundError("Device id required")
        normalized = self._normalize_device_id(device_id)
        device = self._device_objects.get(normalized) or self._find_device_by_id(normalized)
        if device:
            return await self._update_cached_device(device, persist=False)
        async with self._device_cache_lock:
            device_snapshot = self._device_cache.get(normalized)
        if device_snapshot:
            return device_snapshot
        raise DeviceNotFoundError(f"Insteon device {device_id} not found")

    # ------------------------------------------------------------------
    async def send_command(self, device_id: str, command: str, *, level: Optional[int] = None, fast: bool = False, duration: Optional[float] = None) -> Dict[str, Any]:
        if not self._device_manager:
            raise BridgeNotConnected("Cannot send command without PLM connection")
        normalized = self._normalize_device_id(device_id)
        target_device = self._device_objects.get(normalized) or self._find_device_by_id(normalized)
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
            "device_id": normalized,
            "command": command,
            "level": original_level,
            "fast": fast,
        }
        await self._update_cached_device(target_device, persist=False)
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
                    normalized_cache: Dict[str, Dict[str, Any]] = {}
                    for entry in devices:
                        if not isinstance(entry, dict) or "id" not in entry:
                            continue
                        device_id = self._normalize_device_id(entry["id"])
                        entry["id"] = device_id
                        if "address" in entry:
                            entry["address"] = self._normalize_device_id(entry["address"])
                        normalized_cache[device_id] = entry
                    self._device_cache = normalized_cache
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
