# Insteon Device JSON Schema (Draft)

The HomeBrain server persists Insteon devices under `server/data/insteon-devices.json`. A typical device entry looks like:

```json
{
  "id": "aa11bb",
  "address": "aa11bb",
  "name": "Kitchen Pendant",
  "category": 1,
  "subcategory": 32,
  "productKey": "010020",
  "firmware": "9F",
  "capabilities": ["switch", "dimmer"],
  "state": {
    "on_off": true,
    "level": 180
  },
  "lastSeen": "2025-09-25T17:05:23.000Z",
  "room": "Kitchen",
  "labels": ["ceiling"],
  "bridgeMeta": {
    "source": "insteon-bridge",
    "discoveredAt": "2025-09-25T17:00:00.000Z",
    "raw": {
      "model": "2477D",
      "cat": 1,
      "subcat": 32,
      "firmware_version": "9F"
    }
  }
}
```

## Field Reference
- `id` (string, required): canonical lowercase Insteon address with punctuation removed.
- `address` (string, required): mirrors `id` for clarity; retained for compatibility with other device providers.
- `name` (string, required): user-visible label defaulting to bridge-provided description.
- `category` / `subcategory` (integer, optional): Insteon device classification.
- `productKey` (string, optional): manufacturer product key when exposed by the PLM.
- `firmware` (string, optional): firmware identifier reported by the device.
- `capabilities` (array[string], optional): normalized capability set such as `switch`, `dimmer`, `scene_controller`, `sensor`, `battery`.
- `state` (object, optional): most recent known state values (e.g., `on_off`, `level`, `motion`).
- `lastSeen` (ISO-8601 string, optional): timestamp of last event or poll.
- `room` (string, optional): assigned room within HomeBrain.
- `labels` (array[string], optional): user-defined tags.
- `bridgeMeta` (object, optional): metadata from the bridge/discovery.
  - `source` (string): usually `insteon-bridge`.
  - `discoveredAt` (ISO-8601 string): when discovery last ran for this device.
  - `raw` (object): subset of raw modem fields for troubleshooting.

## Collection Format

The persisted JSON file stores a wrapper object:

```json
{
  "devices": [
    { "id": "aa11bb", "name": "Kitchen Pendant", "capabilities": ["switch"] },
    { "id": "cc22dd", "name": "Hallway Sensor", "capabilities": ["sensor"] }
  ],
  "lastSync": "2025-09-25T17:00:00.000Z",
  "lastSyncSummary": {
    "mode": "live",
    "count": 2
  }
}
```

`lastSync` and `lastSyncSummary` are optional metadata written by the Node server after each discovery run.

## Validation Notes
- `id` values must be unique.
- `capabilities` should map to HomeBrain device templates; the server maintains this mapping.
- All timestamps are stored as UTC with a `Z` suffix.
- Additional properties are allowed to support future device-specific metadata.
