# Insteon Device JSON Schema (Draft)

The HomeBrain server persists Insteon devices as an array of objects in server/data/insteon-devices.json. Each entry follows the structure below.

`json
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
`

## Field Reference
- id (string, required): canonical lowercase Insteon address with punctuation removed.
- ddress (string, required): mirrors id for clarity; retained for compatibility with other device providers.
- 
ame (string, required): user-visible label defaulting to bridge-provided description.
- category / subcategory (integer, optional): Insteon device classification.
- productKey (string, optional): manufacturer product key when exposed by PLM.
- irmware (string, optional): firmware identifier.
- capabilities (array[string], optional): normalized set such as switch, dimmer, scene_controller, sensor, attery.
- state (object, optional): most recent known state values (e.g., on_off, level, motion).
- lastSeen (ISO-8601 string, optional): timestamp of last event or poll.
- oom (string, optional): assigned room within HomeBrain UI.
- labels (array[string], optional): user-defined tags.
- ridgeMeta (object, optional): metadata from bridge/discovery.
  - source (string): should be insteon-bridge.
  - discoveredAt (ISO-8601 string): when discovery last ran.
  - aw (object): subset of raw modem fields for troubleshooting.

## Collection Format
The persisted JSON file stores an array of device objects:

`json
{
  "devices": [
    { "id": "aa11bb", "name": "Kitchen Pendant", "capabilities": ["switch"] },
    { "id": "cc22dd", "name": "Hallway Sensor", "capabilities": ["sensor"] }
  ]
}
`

## Validation Notes
- id values must be unique.
- capabilities should map to HomeBrain device templates; maintain a lookup table in the server layer.
- All timestamps stored as UTC with Z suffix.
- Additional properties are permitted to support future device-specific metadata.
