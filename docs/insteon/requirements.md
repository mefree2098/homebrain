# Insteon Integration Requirements (Phase 0)

## Baseline Inventory
- **Central Hub**: NVIDIA Jetson Orin Nano running HomeBrain stack at `/opt/homebrain` (Node.js + React).
- **Insteon Modem**: PowerLinc Modem (USB serial, FTDI 0403:6001) reachable through `/dev/insteon` udev alias per `docs/insteon-bridge.md`.
- **Bridge Service**: Python `aiohttp` service (planned) running as `homebrain-insteon.service`, responsible for PLM connectivity and exposing REST/WebSocket APIs on `http://127.0.0.1:8765`.
- **HomeBrain Server**: Node.js API (Express) with optional MongoDB for settings; other data currently persisted to JSON under `server/data`.
- **Client UI**: React dashboard consuming `/api` endpoints from the server; maintenance tools already expect Insteon sync/test capabilities but operate in demo mode.

## Functional Goals
1. **Device Discovery**
   - Read PLM All-Link Database via `pyinsteon`.
   - Normalize device metadata (address, category, subcategory, firmware, links).
   - Surface device capabilities (switch, dimmer, sensor, keypad, scene responder, etc.).
   - Persist discovered devices and expose them to HomeBrain server.
2. **Command Execution**
   - Handle on/off, dim (0-100), fast on/off, scene activation, and extended commands.
   - Support synchronous acknowledgement plus asynchronous completion events.
3. **State Updates**
   - Subscribe to device status changes/events and forward to HomeBrain in near-real time.
   - Provide polling fallback when subscription unavailable.
4. **Link Management (Stretch Goal)**
   - Trigger All-Link additions/removals if time allows (phase 1.5 or later).
5. **Health and Diagnostics**
   - Expose bridge status (connected, port, attempt counts, last error).
   - Provide verbose logging with rotation support and remote retrieval hooks.

## Non-Functional Requirements
- **Performance**: command dispatch under 500 ms round-trip on LAN; discovery completes under 60 seconds for 100 devices.
- **Reliability**: automatic reconnect on PLM disconnect; retry with exponential backoff (cap at 60 seconds).
- **Security**: bridge bound to localhost by default; optional token auth for remote clients.
- **Observability**: structured logs (JSON) plus metrics counters (pending integration with Prometheus later).

## Persistence Strategy
- **Short-Term (Phase 1/2)**: JSON persistence at `server/data/insteon-devices.json` owned by Node server. Bridge caches in-memory and can persist to `/opt/homebrain/insteon/devices.json` for warm start.
- **Medium-Term**: When MongoDB is fully enabled for the stack, migrate to an `InsteonDevice` collection mirroring the JSON schema. Provide an abstraction layer so either backend can be selected via config `insteonPersistence`.
- **Rationale**: Mongo is optional today; JSON keeps development friction low while enabling deterministic migrations later.

## Integration Points
- **Bridge REST API** (`http://127.0.0.1:8765`)
  - `GET /status`
  - `POST /discovery`
  - `GET /devices`
  - `GET /devices/{id}`
  - `POST /devices/{id}/command`
  - WebSocket `/ws` for async events (state updates, logs).
- **HomeBrain Server**
  - `/api/insteon/status`, `/api/insteon/sync`, `/api/insteon/devices`, and `/api/insteon/devices/:id/commands` endpoints proxy to the bridge, persist device data, and surface results to the UI.
  - Background sync worker pulling states at configurable interval `insteonPollInterval` (default 15 seconds) when WebSocket is unavailable.
- **Client UI**
  - Settings page: bridge configuration, manual sync, port selection.
  - Device management view: list/control Insteon devices (filterable, assign rooms, rename, mark favorites).
  - Dashboard widgets and automation builder hooking into shared device registry.

## Outstanding Questions and Risks
- Confirm actual PLM model (2413U vs 2448A7) to tailor command set and link management.
- Validate Jetson system Python version (3.8 or newer required for `pyinsteon`).
- Determine whether the existing MQTT/event bus should also receive Insteon events.
- Decide on authentication scheme for bridge API if remote UI ever bypasses the Node server.
- Gather mapping between Insteon categories/subcategories and HomeBrain device templates.


1. Build discovery/event pipeline in the Python bridge using live PLM data and persist results to the shared device schema.
2. Layer background polling / event streaming plus automated tests onto the new server APIs once hardware connectivity is verified.
3. Draft Jetson validation checklist covering service deployment, permissions, and end-to-end command smoke tests.

\
