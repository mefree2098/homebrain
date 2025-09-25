"""aiohttp application exposing the Insteon bridge APIs."""

from __future__ import annotations

from typing import Any, Dict, Optional

from aiohttp import WSMsgType, web

from .bridge import BridgeNotConnected, DeviceNotFoundError, InsteonBridge
from .config import BridgeConfig


def _extract_token(request: web.Request) -> Optional[str]:
    header = request.headers.get("Authorization")
    if not header:
        return None
    if header.lower().startswith("bearer "):
        return header[7:]
    return header


class AuthMiddleware:
    def __init__(self, token: Optional[str]):
        self.token = token

    @web.middleware
    async def __call__(self, request: web.Request, handler):
        if not self.token:
            return await handler(request)
        if request.method == "GET" and request.path == "/status":
            return await handler(request)
        provided = _extract_token(request)
        if provided != self.token:
            raise web.HTTPUnauthorized(reason="Invalid or missing bearer token")
        return await handler(request)


async def create_app(config: Optional[BridgeConfig] = None) -> web.Application:
    cfg = config or BridgeConfig.from_env()
    bridge = InsteonBridge(cfg)

    middlewares = [AuthMiddleware(cfg.auth_token)]
    active_middlewares = [mw for mw in middlewares if mw.token]
    app = web.Application(middlewares=active_middlewares)
    app["bridge"] = bridge
    app["config"] = cfg

    async def on_startup(app: web.Application) -> None:
        await bridge.start()

    async def on_cleanup(app: web.Application) -> None:
        await bridge.stop()

    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)

    async def handle_status(request: web.Request) -> web.Response:
        return web.json_response({"success": True, "status": bridge.status_snapshot()})

    async def handle_discovery(request: web.Request) -> web.Response:
        body = await _safe_json(request)
        refresh = body.get("refresh") if isinstance(body, dict) else None
        try:
            result = await bridge.run_discovery(refresh=refresh)
            return web.json_response({"success": True, **result})
        except BridgeNotConnected as exc:
            raise web.HTTPServiceUnavailable(reason=str(exc))

    async def handle_devices(request: web.Request) -> web.Response:
        devices = await bridge.list_devices()
        return web.json_response({"success": True, "devices": devices})

    async def handle_device_detail(request: web.Request) -> web.Response:
        device_id = request.match_info["device_id"]
        try:
            device = await bridge.get_device(device_id)
            return web.json_response({"success": True, "device": device})
        except DeviceNotFoundError as exc:
            raise web.HTTPNotFound(reason=str(exc))

    async def handle_command(request: web.Request) -> web.Response:
        device_id = request.match_info["device_id"]
        body = await _safe_json(request)
        if not isinstance(body, dict):
            raise web.HTTPBadRequest(reason="JSON body required")
        command = body.get("command")
        if not command:
            raise web.HTTPBadRequest(reason="command field required")
        level = body.get("level")
        fast = bool(body.get("fast", False))
        duration = body.get("duration")
        try:
            result = await bridge.send_command(device_id, command, level=level, fast=fast, duration=duration)
            return web.json_response({"success": True, "result": result})
        except DeviceNotFoundError as exc:
            raise web.HTTPNotFound(reason=str(exc))
        except BridgeNotConnected as exc:
            raise web.HTTPServiceUnavailable(reason=str(exc))
        except ValueError as exc:
            raise web.HTTPBadRequest(reason=str(exc))

    async def handle_ws(request: web.Request) -> web.StreamResponse:
        ws = web.WebSocketResponse()
        await ws.prepare(request)
        bridge.attach_ws_client(ws)
        await ws.send_json({"type": "ws_connected", "status": bridge.status_snapshot()})
        try:
            async for msg in ws:  # noqa: F841 - inbound messages ignored for now
                if msg.type == WSMsgType.ERROR:
                    break
        finally:
            bridge.detach_ws_client(ws)
        return ws

    app.router.add_get("/status", handle_status)
    app.router.add_post("/discovery", handle_discovery)
    app.router.add_get("/devices", handle_devices)
    app.router.add_get("/devices/{device_id}", handle_device_detail)
    app.router.add_post("/devices/{device_id}/command", handle_command)
    app.router.add_get("/ws", handle_ws)

    return app


async def _safe_json(request: web.Request) -> Dict[str, Any]:
    if not request.can_read_body:
        return {}
    try:
        data = await request.json()
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def main() -> None:
    cfg = BridgeConfig.from_env()
    web.run_app(create_app(cfg), host=cfg.http_host, port=cfg.http_port)


__all__ = ["create_app", "main"]
