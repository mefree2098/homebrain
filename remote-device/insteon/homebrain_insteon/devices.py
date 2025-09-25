"""Helpers for representing Insteon devices in a HomeBrain-friendly format."""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any, Dict, Iterable, List, Optional
import datetime as _dt


@dataclass
class DeviceSnapshot:
    id: str
    address: str
    name: str
    category: Optional[int]
    subcategory: Optional[int]
    product_key: Optional[str]
    firmware: Optional[str]
    capabilities: List[str]
    state: Dict[str, Any]
    last_seen: Optional[str]
    raw: Dict[str, Any]

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def _expr_to_str(value: Any) -> str:
    if isinstance(value, bytes):
        return value.hex()
    return str(value)


def _coerce_address(address: Any) -> str:
    if address is None:
        return "unknown"
    for attr in ("id", "as_hex", "hex", "address"):
        value = getattr(address, attr, None)
        if value:
            if callable(value):
                try:
                    value = value()
                except Exception:
                    continue
            return _expr_to_str(value).replace(".", "").replace(":", "").lower()
    return _expr_to_str(address).replace(".", "").replace(":", "").lower()


def _coerce_name(device: Any, address: str) -> str:
    for attr in ("name", "label", "description"):
        value = getattr(device, attr, None)
        if value:
            if callable(value):
                try:
                    value = value()
                except Exception:
                    continue
            if isinstance(value, str) and value.strip():
                return value.strip()
    return f"Insteon {address.upper()}"


def _maybe_int(device: Any, *attr_candidates: str) -> Optional[int]:
    for attr in attr_candidates:
        value = getattr(device, attr, None)
        if value is None:
            continue
        if callable(value):
            try:
                value = value()
            except Exception:
                continue
        try:
            return int(value)
        except Exception:
            continue
    return None


def _extract_capabilities(device: Any) -> List[str]:
    capabilities: List[str] = []
    capability_map = {
        "dimmable": "dimmer",
        "switchable": "switch",
        "is_dimmable": "dimmer",
        "is_switch": "switch",
        "is_scene_controller": "scene_controller",
        "is_keypad": "keypad",
        "has_battery": "battery",
        "supports_fast_on": "fast_on",
        "supports_fast_off": "fast_off",
        "supports_status": "status_query",
    }
    for attr, label in capability_map.items():
        value = getattr(device, attr, None)
        if value:
            if callable(value):
                try:
                    value = value()
                except Exception:
                    continue
        if bool(value):
            capabilities.append(label)
    try:
        states = getattr(device, "states", None)
        if states:
            for key in states.keys():
                key_str = str(key).lower()
                if key_str.startswith("level") and "dimmer" not in capabilities:
                    capabilities.append("dimmer")
                elif key_str.startswith("on_off") and "switch" not in capabilities:
                    capabilities.append("switch")
    except Exception:
        pass
    return sorted(set(capabilities))


def _extract_state(device: Any) -> Dict[str, Any]:
    state: Dict[str, Any] = {}
    states = getattr(device, "states", None)
    if isinstance(states, dict):
        for key, value in states.items():
            key_name = str(key)
            if hasattr(value, "value"):
                try:
                    state_value = value.value
                except Exception:
                    state_value = None
            else:
                state_value = value
            if isinstance(state_value, (int, float, str, bool)) or state_value is None:
                state[key_name] = state_value
    return state


def _extract_last_seen(device: Any) -> Optional[str]:
    for attr in ("last_update", "last_updated", "last_seen", "last_activity"):
        value = getattr(device, attr, None)
        if value is None:
            continue
        if callable(value):
            try:
                value = value()
            except Exception:
                continue
        try:
            if isinstance(value, str):
                return value
            if isinstance(value, _dt.datetime):
                return value.astimezone().isoformat() if value.tzinfo else value.isoformat()
            if isinstance(value, _dt.date):
                combined = _dt.datetime.combine(value, _dt.time())
                return combined.isoformat()
        except Exception:
            continue
    return None


def device_to_snapshot(device: Any) -> DeviceSnapshot:
    address = _coerce_address(getattr(device, "address", None))
    name = _coerce_name(device, address)
    category = _maybe_int(device, "cat", "category", "device_category")
    subcategory = _maybe_int(device, "subcat", "subcategory", "device_subcategory")
    product_key = None
    for attr in ("product_key", "product_key_str"):
        value = getattr(device, attr, None)
        if value:
            if callable(value):
                try:
                    value = value()
                except Exception:
                    continue
            product_key = str(value)
            break
    firmware = None
    for attr in ("firmware_version", "fw_version", "firmware"):
        value = getattr(device, attr, None)
        if value:
            if callable(value):
                try:
                    value = value()
                except Exception:
                    continue
            firmware = str(value)
            break
    capabilities = _extract_capabilities(device)
    state = _extract_state(device)
    last_seen = _extract_last_seen(device)
    raw_meta: Dict[str, Any] = {}
    for attr in ("model", "cat", "subcat", "firmware_version"):
        try:
            value = getattr(device, attr, None)
            if value is None:
                continue
            if callable(value):
                try:
                    value = value()
                except Exception:
                    continue
            raw_meta[attr] = _expr_to_str(value)
        except Exception:
            continue
    return DeviceSnapshot(
        id=address,
        address=address,
        name=name,
        category=category,
        subcategory=subcategory,
        product_key=product_key,
        firmware=firmware,
        capabilities=capabilities,
        state=state,
        last_seen=last_seen,
        raw=raw_meta,
    )


def snapshot_collection(devices: Iterable[Any]) -> List[Dict[str, Any]]:
    return [device_to_snapshot(device).to_dict() for device in devices]


__all__ = ["DeviceSnapshot", "device_to_snapshot", "snapshot_collection"]
