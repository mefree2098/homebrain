"""Configuration helpers for the HomeBrain Insteon bridge."""

from __future__ import annotations

from dataclasses import dataclass, replace
from pathlib import Path
from typing import Optional
import os


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    value = value.strip().lower()
    return value in {"1", "true", "yes", "on"}


@dataclass
class BridgeConfig:
    serial_port: str
    http_host: str
    http_port: int
    reconnect_initial: float
    reconnect_max: float
    status_cache_ttl: float
    discovery_refresh_default: bool
    device_cache_path: Path
    allow_mock_mode: bool
    mock_fallback_on_failure: bool
    force_mock_mode: bool
    mock_device_cycle_seconds: float
    auth_token: Optional[str]
    websocket_event_buffer: int
    log_level: str

    @classmethod
    def from_env(cls) -> "BridgeConfig":
        serial_port = os.getenv("INSTEON_TTY", "/dev/insteon")
        http_host = os.getenv("INSTEON_BIND", "0.0.0.0")
        http_port = int(os.getenv("INSTEON_HTTP_PORT", os.getenv("INSTEON_PORT", "8765")))
        reconnect_initial = float(os.getenv("INSTEON_RECONNECT_SECONDS", "5"))
        reconnect_max = float(os.getenv("INSTEON_RECONNECT_MAX_SECONDS", "60"))
        status_cache_ttl = float(os.getenv("INSTEON_STATUS_CACHE_SECONDS", "2"))
        discovery_refresh_default = _env_bool("INSTEON_DISCOVERY_REFRESH", True)
        device_cache_path = Path(os.getenv("INSTEON_DEVICE_CACHE", "/opt/homebrain/insteon/devices.json"))
        allow_mock_mode = _env_bool("INSTEON_ALLOW_MOCK", False)
        mock_fallback_on_failure = _env_bool("INSTEON_MOCK_FALLBACK", True)
        mock_device_cycle_seconds = float(os.getenv("INSTEON_MOCK_DEVICE_CYCLE_SECONDS", "15"))
        force_mock_mode = _env_bool("INSTEON_FORCE_MOCK", False)
        auth_token = os.getenv("INSTEON_AUTH_TOKEN") or None
        websocket_event_buffer = int(os.getenv("INSTEON_WS_EVENT_BUFFER", "1000"))
        log_level = os.getenv("INSTEON_LOG_LEVEL", "INFO")

        return cls(
            serial_port=serial_port,
            http_host=http_host,
            http_port=http_port,
            reconnect_initial=reconnect_initial,
            reconnect_max=reconnect_max,
            status_cache_ttl=status_cache_ttl,
            discovery_refresh_default=discovery_refresh_default,
            device_cache_path=device_cache_path,
            allow_mock_mode=allow_mock_mode,
            mock_fallback_on_failure=mock_fallback_on_failure,
            force_mock_mode=force_mock_mode,
            mock_device_cycle_seconds=mock_device_cycle_seconds,
            auth_token=auth_token,
            websocket_event_buffer=websocket_event_buffer,
            log_level=log_level,
        )


__all__ = ["BridgeConfig", "_env_bool", "replace"]
