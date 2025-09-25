# Insteon PLM Management Buildout Plan

> Primary executor: Codex AI (this agent). Document written to be actionable without ambiguity.

---

## Progress Log (2025-09-25)

### Completed
- Created `docs/insteon/requirements.md` documenting baseline assumptions, persistence decisions, and integration points.
- Added `docs/insteon/device-schema.md` capturing the JSON structure shared between the bridge and HomeBrain server.
- Scaffolded Python bridge package at `remote-device/insteon/` with connection lifecycle, REST/WebSocket endpoints, caching, and auth hooks; verified syntax via `python -m compileall`.

### Next Steps
1. Exercise discovery/command flows against a live PLM to validate pyinsteon usage and enrich capability mapping.
2. Implement Phase 2 server wiring (settings fields, persistence adapters, REST endpoints) targeting the new device schema.
3. Backfill automated tests (unit + integration) and prepare Jetson deployment checklist for bridge rollout.

---

## Phase 0 - Baseline & Requirements Alignment

### Objectives
- Confirm hardware/software baseline (Jetson, PLM model, bridge service, HomeBrain stack).
- Capture detailed functional goals for Insteon device management.

### Tasks
1. **Inventory current stack**
   - systemctl status homebrain-insteon.service
   - Confirm bridge endpoint (default http://127.0.0.1:8765).
   - Verify PLM port path (e.g. /dev/ttyUSB0) and permissions (groups homebrain).
2. **Document desired capabilities**
   - Device discovery scope (lighting, sensors, scenes?).
   - Required control actions (on/off, dim, scene triggers, linking).
   - State feedback requirements.
   - Performance expectations (scan frequency, command latency).
3. **Decide persistence layer**
   - Prefer MongoDB (existing optional dependency) vs. JSON file fallback.
4. **Identify integration points**
   - Server endpoints (REST/WS), event model, UI surfaces.

### Deliverables
- docs/insteon/requirements.md summarizing above.
- Decision on persistence backend.

### Status (2025-09-25)
- Completed: baseline requirements captured in `docs/insteon/requirements.md`; JSON device schema drafted at `docs/insteon/device-schema.md`.
- Next Steps:
  1. Confirm PLM hardware details and bridge service status on the Jetson (`systemctl status homebrain-insteon.service`).
  2. Socialize the device schema with server owners before persistence work begins.

---

## Phase 1 - Bridge Service Enhancements

### Objectives
Transform the Python bridge into a full-featured PLM client exposing REST/WebSocket endpoints usable by the Node server.

### Tasks
1. **Repository setup**
   - Create remote-device/insteon/ module or separate repo (decide in Phase 0).
2. **API design**
   - REST endpoints:
     - GET /status - bridge health, PLM info.
     - POST /discovery - initiate all-link database read.
     - GET /devices - list cached devices.
     - GET /devices/{id} - device details, capabilities.
     - POST /devices/{id}/command - send command payload.
   - WebSocket/Server-Sent Events for live notifications (optional but recommended).
3. **Device discovery implementation**
   - Use pyinsteon.aldb to read all-link database.
   - Normalize device IDs (hex string) and capture categories/subcategories.
   - Cache results in bridge memory (and optionally disk).
4. **Command execution**
   - Map high-level actions to pyinsteon.commands (on/off, dim, extended commands).
5. **State subscription**
   - Register event callbacks (e.g., devices.all_devices listener) -> push via WS.
6. **Error handling & security**
   - Auth for bridge (token or IP whitelist) - configurable.
   - Graceful reconnect on PLM drop.
7. **Packaging**
   - Systemd unit updates, logging via journalctl.

### Deliverables
- Updated bridge code with docs (remote-device/README.md).
- Automated tests or manual test script verifying discovery and commands.
- Postman (or curl) examples for API usage.

### Status (2025-09-25)
- Completed: Python bridge scaffolding added under `remote-device/insteon/` (config, device serialization, REST/WS endpoints, caching, auth).
- Next Steps:
  1. Implement discovery callbacks and real-time event push once connected to hardware.
  2. Flesh out command mapping (scene support, extended commands) and add automated tests/examples.
  3. Document service packaging/systemd updates in `docs/insteon/setup.md` after validation.

### Acceptance Criteria
- curl http://localhost:8765/devices returns JSON array of discovered devices.
- POST /devices/{id}/command turns a real device on/off.

---

## Phase 2 - Server Integration Layer

### Objectives
Extend HomeBrain Node server to consume bridge APIs and persist Insteon device metadata/state.

### Tasks
1. **Configuration updates**
   - Settings model: add fields insteonBridgeUrl, insteonPollInterval, insteonEnabled.
   - Settings UI updates to edit/save these.
2. **Bridge client utility**
   - New module in server/utils/insteonClient.js using fetchWithFallback to call bridge.
   - Handle auth tokens if configured.
3. **Device persistence**
   - Implement repository (Mongo schema InsteonDevice OR JSON fallback under server/data/insteon-devices.json). Fields: id, name, category, subCategory, address, capabilities, room, state, lastSeen, bridgeMeta.
4. **Sync service**
   - POST /api/insteon/sync endpoint -> call bridge discovery -> upsert devices -> return summary.
   - Background poller (configurable interval) to refresh states.
5. **Command endpoints**
   - POST /api/insteon/devices/:id/commands -> forward to bridge, update state.
6. **Event ingestion**
   - If bridge supports WS, create listener; otherwise schedule polling.
7. **Error handling**
   - Clear separation between bridge errors vs. local persistence errors.

### Deliverables
- Updated server routes & services.
- Tests (unit/integration) mocking bridge responses.
- Migration script to import existing demo devices (optional).

### Acceptance Criteria
- POST /api/insteon/sync imports actual PLM device list.
- GET /api/insteon/devices returns persisted data.
- Command endpoint toggles real hardware via bridge.

---

## Phase 3 - UI & User Experience

### Objectives
Expose full Insteon management in HomeBrain dashboard/settings.

### Tasks
1. **Settings page**
   - Display bridge status (last sync, device count, errors).
   - Allow manual sync, command test, and view bridge logs link.
2. **Device management page**
   - New tab or card listing Insteon devices with filters (room, category).
   - Actions: on/off, dim slider, rename, assign room, mark favorite.
3. **Dashboard widgets**
   - Update device tiles to include Insteon-specific capabilities.
   - Real-time state refresh using existing WebSocket or polling.
4. **Error UX**
   - Toasts/surface for bridge offline, permission issues.
5. **Mobile/responsive considerations**
   - Ensure controls accessible on touch interfaces.

### Deliverables
- Updated React components, hooks, API calls.
- Storybook (optional) entries for new components.

### Acceptance Criteria
- Users can fully control devices from UI with immediate feedback.
- Insteon devices appear alongside others in dashboards.

---

## Phase 4 - Automation & Scenes Integration

### Objectives
Allow Insteon devices to participate in HomeBrain automations, scenes, and voice flows.

### Tasks
1. **Scene engine**
   - Map Insteon device actions into existing scene definitions.
2. **Automation triggers/conditions**
   - Support triggers from device state changes (e.g., motion sensor).
3. **Voice commands**
   - Ensure voice parser can address Insteon devices (naming, synonyms).
4. **Wake word device routing**
   - Attribute commands to room-specific Insteon devices where applicable.

### Deliverables
- Updated automation service logic & tests.
- Sample automations showcasing Insteon usage.

### Acceptance Criteria
- Scenes can toggle Insteon lights alongside other devices.
- Automations fire on Insteon sensor events.

---

## Phase 5 - Reliability, Diagnostics, and Docs

### Objectives
Harden solution, provide troubleshooting tooling, and document operations.

### Tasks
1. **Health checks**
   - Server endpoint reporting bridge connectivity, last sync errors.
   - UI status indicator.
2. **Retry/backoff strategy**
   - Gracefully handle bridge downtime (queue commands, reattempt on recovery).
3. **Logging/alerting**
   - Structured logs for discovery/command failures.
   - Optional notification integration (email/push).
4. **Documentation**
   - docs/insteon/setup.md: full install, permission steps, service control.
   - docs/insteon/troubleshooting.md: common errors, log locations.
5. **QA & demo scripts**
   - Test matrix covering discovery, control, scenes, automations.
   - Demo script for stakeholders.

### Deliverables
- Health endpoints/tests.
- Updated documentation.
- QA report with results.

### Acceptance Criteria
- Monitoring shows bridge/server recovery without manual intervention.
- Documentation allows fresh setup by another engineer.

---

## Phase 6 - Deployment & Post-Launch

### Objectives
Roll out changes safely and support post-launch monitoring.

### Tasks
1. **Staging rollout**
   - Deploy to staging Jetson/PLM first, run regression tests.
2. **Production rollout**
   - Schedule maintenance window if needed.
   - Backup existing configs/devices.
3. **Post-launch monitoring**
   - Watch logs, health metrics for 48h.
   - Collect user feedback, triage issues.
4. **Backlog grooming**
   - Capture nice-to-haves (linking, scene import, advanced device types).

### Deliverables
- Release notes.
- Monitoring plan.
- Post-launch report.

---

## Phase Interdependencies & Scheduling Notes
- Phases are sequential; certain subtasks can run in parallel (e.g., Phase 1 API design while Phase 0 documentation is finalized).
- Establish a feature flag or insteonEnabled toggle to guard production rollout.
- Keep feature branches per phase; use PRs with integration tests before merge.

---

## Tracking & Execution Guidance
- Create GitHub issues per task with estimated effort.
- Use docs/insteon/CHANGELOG.md to summarize progress each phase.
- Maintain local dev environment with bridge stub for unit tests.
- For automated tests, mock bridge responses with nock/supertest or Python fixtures.

---

## Success Definition
- All Insteon devices managed end-to-end (discovery, control, state feedback) through HomeBrain.
- Users can incorporate Insteon hardware into scenes, automations, and voice workflows without manual intervention.
- Operational docs allow onboarding of another engineer without institutional knowledge.

