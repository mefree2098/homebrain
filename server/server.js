const express = require('express');
const cors = require('cors');
let helmet;
try {
  helmet = require('helmet');
} catch (error) {
  console.warn('helmet not installed; continuing without security headers. Run `npm install` in server/ to restore.', error.message);
  helmet = () => (req, res, next) => next();
}
const morgan = require('morgan');
const path = require('path');
const mongoose = require('mongoose');
const fs = require('fs');
const { randomUUID } = require('crypto');
require('dotenv').config();

const SettingsModel = require('./models/Settings');
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const deepClone = (value) => JSON.parse(JSON.stringify(value));

const generateId = (prefix = 'hb') => `${prefix}-${randomUUID()}`;

const isSettingsDbConnected = () => mongoose.connection && mongoose.connection.readyState === 1;
const isDbConnected = () => false;

const ACCESS_CONTROL_ALLOWLIST = (process.env.CORS_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean);

const createMemoryStore = () => ({
  devices: [
    { _id: 'dev-1', name: 'Living Room Lamp', type: 'light', room: 'Living Room', status: true, brightness: 70 },
    { _id: 'dev-2', name: 'Hallway Thermostat', type: 'thermostat', room: 'Hallway', status: true, temperature: 72 },
    { _id: 'dev-3', name: 'Front Door Lock', type: 'lock', room: 'Entry', status: true },
    { _id: 'dev-4', name: 'Bedroom Lamp', type: 'light', room: 'Bedroom', status: false, brightness: 0 },
  ],
  scenes: [
    { _id: 'scene-1', name: 'Movie Night', description: 'Dim lights, set temp to 70', devices: ['dev-1', 'dev-2'], active: false },
    { _id: 'scene-2', name: 'Good Morning', description: 'Turn on lights, set temp to 72', devices: ['dev-1', 'dev-4', 'dev-2'], active: false },
  ],
  automations: [
    {
      _id: 'auto-1',
      name: 'Morning Wake Up',
      description: 'Gradually brighten the bedroom lights and warm the house before everyone wakes up.',
      trigger: { type: 'schedule', time: '07:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'] },
      actions: [
        { deviceId: 'dev-4', action: 'set_brightness', value: 80 },
        { deviceId: 'dev-2', action: 'set_temperature', value: 72 },
      ],
      enabled: true,
      lastRun: null,
      category: 'schedule',
      priority: 2,
      conditions: [],
      cooldown: 0,
    },
    {
      _id: 'auto-2',
      name: 'Goodnight Lockdown',
      description: 'Turn off common-area lights and lock doors when someone says goodnight.',
      trigger: { type: 'voice', phrase: 'goodnight', roomContext: 'any' },
      actions: [
        { deviceId: 'dev-1', action: 'turn_off' },
        { deviceId: 'dev-3', action: 'lock' },
      ],
      enabled: true,
      lastRun: null,
      category: 'voice',
      priority: 1,
      conditions: [{ type: 'time', after: '21:00' }],
      cooldown: 300,
    },
    {
      _id: 'auto-3',
      name: 'Away Mode',
      description: 'Run when the home is set to away mode to keep the space secure.',
      trigger: { type: 'mode_change', mode: 'away' },
      actions: [
        { deviceId: 'dev-1', action: 'turn_off' },
        { deviceId: 'dev-4', action: 'turn_off' },
      ],
      enabled: false,
      lastRun: null,
      category: 'mode',
      priority: 3,
      conditions: [{ type: 'security', alarmState: 'armedAway' }],
      cooldown: 0,
    },
  ],
  voiceDevices: [
    { _id: 'voice-1', name: 'Kitchen Speaker', room: 'Kitchen', deviceType: 'speaker', status: 'online', lastSeen: new Date().toISOString(), powerSource: 'AC', connectionType: 'wifi', ipAddress: '192.168.1.20', volume: 60, microphoneSensitivity: 70, uptime: 3600 },
    { _id: 'voice-2', name: 'Bedroom Speaker', room: 'Bedroom', deviceType: 'speaker', status: 'offline', lastSeen: new Date(Date.now() - 3600_000).toISOString(), powerSource: 'AC', connectionType: 'wifi', volume: 40, microphoneSensitivity: 60, uptime: 0 },
  ],
  voiceCommandHistory: [
    { _id: 'cmd-1', user: 'Matt', command: 'Turn on the living room lamp', deviceId: 'dev-1', status: 'success', timestamp: new Date(Date.now() - 45 * 60_000).toISOString() },
    { _id: 'cmd-2', user: 'Kate', command: 'Set thermostat to 72', deviceId: 'dev-2', status: 'success', timestamp: new Date(Date.now() - 2 * 60 * 60_000).toISOString() },
  ],
  remoteDevices: [
    {
      _id: 'remote-1',
      name: 'Kitchen Satellite',
      room: 'Kitchen',
      deviceType: 'speaker',
      status: 'online',
      ipAddress: '192.168.1.45',
      macAddress: 'AA:BB:CC:DD:EE:11',
      firmwareVersion: '1.0.3',
      batteryLevel: null,
      powerSource: 'wired',
      uptime: 12_600,
      lastHeartbeat: new Date(Date.now() - 60 * 1000).toISOString(),
      registrationCode: null,
      registrationRequestedAt: null,
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ],
  discovery: {
    enabled: true,
    lastScan: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    autoApproveRooms: ['Kitchen', 'Living Room'],
    pendingDevices: [
      { id: 'pending-1', name: 'Kitchen Satellite', type: 'speaker', macAddress: 'AA:BB:CC:DD:EE:01', ipAddress: '192.168.1.45', firmwareVersion: '1.0.3', capabilities: ['microphone', 'speaker', 'led'], timestamp: new Date(Date.now() - 90 * 1000).toISOString(), status: 'pending' },
      { id: 'pending-2', name: 'Office Button', type: 'button', macAddress: 'AA:BB:CC:DD:EE:02', ipAddress: '192.168.1.46', firmwareVersion: '1.1.0', capabilities: ['button', 'led'], timestamp: new Date(Date.now() - 4 * 60 * 1000).toISOString(), status: 'pending' },
    ],
  },
  smartthings: {
    devices: [
      { id: 'st-device-1', name: 'SmartThings Hub', label: 'Main Hub', room: 'Network Closet', deviceType: 'hub', components: ['main'], status: 'online', healthState: 'ONLINE', manufacturer: 'Samsung', model: 'STH-ETH-250', capabilities: ['bridge'], lastActivity: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
      { id: 'st-device-2', name: 'Entry Light', label: 'Entry Pendant', room: 'Entry', deviceType: 'switch', components: ['main'], status: 'online', healthState: 'ONLINE', manufacturer: 'GE', model: 'SmartSwitch', capabilities: ['switch', 'switchLevel'], level: 60, lastActivity: new Date(Date.now() - 2 * 60 * 1000).toISOString() },
      { id: 'st-device-3', name: 'Hallway Sensor', label: 'Hall Motion', room: 'Hallway', deviceType: 'sensor', components: ['main'], status: 'online', healthState: 'ONLINE', manufacturer: 'Aeotec', model: 'MultiSensor', capabilities: ['motionSensor', 'temperatureMeasurement'], temperature: 70, motion: 'inactive', lastActivity: new Date(Date.now() - 15 * 60 * 1000).toISOString() },
    ],
    scenes: [
      { id: 'st-scene-1', name: 'Good Morning', description: 'Turn on downstairs lights and start coffee.', room: 'Downstairs', lastExecuted: null },
      { id: 'st-scene-2', name: 'Good Night', description: 'Turn off lights and lock doors.', room: 'Whole Home', lastExecuted: null },
    ],
  },
  security: {
    status: {
      alarmState: 'disarmed',
      isArmed: false,
      isTriggered: false,
      isOnline: true,
      zoneCount: 4,
      activeZones: 1,
      bypassedZones: 0,
      lastArmed: null,
      lastDisarmed: new Date().toISOString(),
      armedBy: null,
      lastTriggered: null,
    },
    alarm: {
      _id: 'alarm-1',
      name: 'HomeBrain Security',
      alarmState: 'disarmed',
      isOnline: true,
      smartthingsDeviceId: null,
      zones: [
        { zoneId: 'zone-1', deviceId: 'dev-3', name: 'Front Door', deviceType: 'lock', status: 'closed', bypassed: false, enabled: true, bypassable: true, lastTriggered: null },
        { zoneId: 'zone-2', deviceId: 'st-device-3', name: 'Hallway Motion', deviceType: 'sensor', status: 'clear', bypassed: false, enabled: true, bypassable: true, lastTriggered: null },
      ],
      entryDelay: 30,
      exitDelay: 60,
      lastArmed: null,
      lastDisarmed: new Date().toISOString(),
      armedBy: null,
      disarmedBy: 'Demo User',
      lastTriggered: null,
      isOnline: true,
    },
  },
});

let memoryStore = createMemoryStore();

const DEFAULT_SETTINGS = {
  location: 'New York, NY',
  timezone: 'America/New_York',
  wakeWordSensitivity: 0.7,
  voiceVolume: 0.8,
  microphoneSensitivity: 0.6,
  enableVoiceConfirmation: true,
  enableNotifications: true,
  insteonPort: '/dev/ttyUSB0',
  smartthingsToken: '',
  smartthingsClientId: '',
  smartthingsClientSecret: '',
  smartthingsRedirectUri: '',
  elevenlabsApiKey: '',
  llmProvider: 'openai',
  openaiApiKey: '',
  openaiModel: 'gpt-4',
  anthropicApiKey: '',
  anthropicModel: 'claude-3-sonnet-20240229',
  localLlmEndpoint: 'http://localhost:8080',
  localLlmModel: 'llama2-7b',
  enableSecurityMode: false,
};

let appSettings = { ...DEFAULT_SETTINGS };
const dataDir = path.join(__dirname, 'data');
const settingsFilePath = path.join(dataDir, 'settings.json');

const ensureDataDir = () => {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
};

async function readSettingsPersisted() {
  if (isSettingsDbConnected()) {
    try {
      const doc = await SettingsModel.getSettings();
      return doc.toObject();
    } catch (error) {
      console.warn('readSettingsPersisted(DB) failed, falling back to file:', error.message);
    }
  }

  try {
    if (fs.existsSync(settingsFilePath)) {
      return JSON.parse(fs.readFileSync(settingsFilePath, 'utf-8'));
    }
  } catch (error) {
    console.warn('readSettingsPersisted(file) failed:', error.message);
  }

  return { ...DEFAULT_SETTINGS };
}

async function writeSettingsPersisted(updates) {
  const current = await readSettingsPersisted();
  const next = { ...current, ...updates };

  if (isSettingsDbConnected()) {
    try {
      const saved = await SettingsModel.updateSettings(next);
      return saved.toObject();
    } catch (error) {
      console.warn('writeSettingsPersisted(DB) failed, continuing with file persistence only:', error.message);
    }
  }

  try {
    ensureDataDir();
    fs.writeFileSync(settingsFilePath, JSON.stringify(next, null, 2), 'utf-8');
  } catch (error) {
    console.error('writeSettingsPersisted(file) failed:', error.message);
  }

  return next;
}

const maskSensitiveSettings = (settings) => {
  const masked = { ...settings };
  const sensitiveKeys = [
    'elevenlabsApiKey',
    'smartthingsToken',
    'smartthingsClientSecret',
    'openaiApiKey',
    'anthropicApiKey',
  ];

  sensitiveKeys.forEach((key) => {
    if (masked[key]) {
      masked[key] = masked[key].replace(/.(?=.{4})/g, '*');
    }
  });

  return masked;
};
const buildMockSmartThingsSummary = () => ({
  connected: memoryStore.smartthings?.isConnected ?? true,
  devices: deepClone(memoryStore.smartthings?.devices || []),
  scenes: deepClone(memoryStore.smartthings?.scenes || []),
});

const getMockVoices = () => ([
  { id: 'voice_demo_anna', name: 'Anna', labels: ['Friendly', 'Warm'] },
  { id: 'voice_demo_henry', name: 'Henry', labels: ['Calm', 'Helpful'] },
]);

const testMockProvider = (provider) => ({
  provider,
  ok: true,
  latencyMs: 120,
  timestamp: new Date().toISOString(),
});

const app = express();

const corsOptions = ACCESS_CONTROL_ALLOWLIST.length
  ? {
      origin(origin, callback) {
        if (!origin || ACCESS_CONTROL_ALLOWLIST.includes(origin)) {
          return callback(null, true);
        }
        return callback(new Error('Not allowed by CORS'));
      },
      credentials: true,
    }
  : { origin: true, credentials: true };

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(cors(corsOptions));
app.use(express.json({ limit: '4mb' }));
app.use(morgan('dev'));

let server;
let logServer;
let isShuttingDown = false;
const sendSuccess = (res, payload = {}, status = 200) => {
  if (payload.success === undefined) {
    payload = { success: true, ...payload };
  }
  return res.status(status).json(payload);
};

const sendError = (res, status, message, details) => {
  const body = { success: false, message };
  if (details) body.details = details;
  return res.status(status).json(body);
};
const DEMO_USER = Object.freeze({
  id: 'user-demo',
  name: 'HomeBrain Demo',
  role: 'admin',
});

const buildDemoAuthResponse = (email = 'demo@homebrain.local') => {
  const normalizedEmail = (email || 'demo@homebrain.local').toLowerCase();
  return {
    accessToken: `demo-access-${randomUUID()}`,
    refreshToken: `demo-refresh-${randomUUID()}`,
    user: { ...DEMO_USER, email: normalizedEmail },
  };
};

app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return sendError(res, 400, 'Email is required');
  }

  const authPayload = buildDemoAuthResponse(email);
  return sendSuccess(res, authPayload, 201);
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email } = req.body || {};
  if (!email) {
    return sendError(res, 400, 'Email is required');
  }

  const authPayload = buildDemoAuthResponse(email);
  return sendSuccess(res, authPayload);
}));

app.post('/api/auth/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return sendError(res, 400, 'refreshToken is required');
  }

  const authPayload = buildDemoAuthResponse();
  return sendSuccess(res, authPayload);
}));

app.post('/api/auth/logout', asyncHandler(async (_req, res) => {
  return sendSuccess(res, { message: 'Logged out' });
}));
const SENSITIVE_PLACEHOLDER_PATTERN = /^\u0007+/;
const SENSITIVE_KEYS = new Set([
  'elevenlabsApiKey',
  'smartthingsToken',
  'smartthingsClientSecret',
  'openaiApiKey',
  'anthropicApiKey',
]);

function stripSensitivePlaceholders(partialSettings, currentSettings) {
  const result = { ...partialSettings };
  for (const key of Object.keys(partialSettings)) {
    if (SENSITIVE_KEYS.has(key) && typeof partialSettings[key] === 'string' && SENSITIVE_PLACEHOLDER_PATTERN.test(partialSettings[key])) {
      if (currentSettings && currentSettings[key] !== undefined) {
        result[key] = currentSettings[key];
      } else {
        delete result[key];
      }
    }
  }
  return result;
}

app.get('/api/settings', asyncHandler(async (req, res) => {
  const persisted = await readSettingsPersisted();
  appSettings = { ...DEFAULT_SETTINGS, ...persisted };
  return sendSuccess(res, { settings: maskSensitiveSettings(appSettings) });
}));

app.put('/api/settings', asyncHandler(async (req, res) => {
  const updates = req.body || {};
  const merged = stripSensitivePlaceholders(updates, appSettings);
  const saved = await writeSettingsPersisted(merged);
  appSettings = { ...DEFAULT_SETTINGS, ...saved };
  return sendSuccess(res, { message: 'Settings updated', settings: maskSensitiveSettings(appSettings) });
}));

app.get('/api/settings/:key', asyncHandler(async (req, res) => {
  const key = req.params.key;
  if (!(key in appSettings)) {
    return sendError(res, 404, 'Setting not found');
  }
  return sendSuccess(res, { key, value: appSettings[key] });
}));
app.post('/api/settings/test-elevenlabs', asyncHandler(async (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey && !appSettings.elevenlabsApiKey) {
    return sendError(res, 400, 'apiKey required');
  }

  if (apiKey) {
    appSettings.elevenlabsApiKey = apiKey;
    await writeSettingsPersisted({ elevenlabsApiKey: apiKey });
  }

  const voices = getMockVoices();
  return sendSuccess(res, { success: true, message: 'ElevenLabs key accepted (mock)', voiceCount: voices.length, voices });
}));

app.post('/api/settings/test-openai', asyncHandler(async (req, res) => {
  const { apiKey, model } = req.body || {};
  const key = apiKey || appSettings.openaiApiKey;
  if (!key) {
    return sendError(res, 400, 'apiKey required');
  }

  const result = testMockProvider('openai');
  appSettings.openaiApiKey = key;
  if (model) {
    appSettings.openaiModel = model;
  }
  await writeSettingsPersisted({ openaiApiKey: key, ...(model ? { openaiModel: model } : {}) });
  return sendSuccess(res, { success: true, message: 'OpenAI key accepted (mock)', model: model || appSettings.openaiModel, result });
}));

app.post('/api/settings/test-anthropic', asyncHandler(async (req, res) => {
  const { apiKey, model } = req.body || {};
  const key = apiKey || appSettings.anthropicApiKey;
  if (!key) {
    return sendError(res, 400, 'apiKey required');
  }

  const result = testMockProvider('anthropic');
  appSettings.anthropicApiKey = key;
  if (model) {
    appSettings.anthropicModel = model;
  }
  await writeSettingsPersisted({ anthropicApiKey: key, ...(model ? { anthropicModel: model } : {}) });
  return sendSuccess(res, { success: true, message: 'Anthropic key accepted (mock)', model: model || appSettings.anthropicModel, result });
}));

app.post('/api/settings/test-local-llm', asyncHandler(async (req, res) => {
  const { endpoint, model } = req.body || {};
  const url = endpoint || appSettings.localLlmEndpoint;
  if (!url) {
    return sendError(res, 400, 'endpoint required');
  }

  const result = testMockProvider('local-llm');
  if (endpoint) {
    appSettings.localLlmEndpoint = endpoint;
  }
  if (model) {
    appSettings.localLlmModel = model;
  }
  await writeSettingsPersisted({
    ...(endpoint ? { localLlmEndpoint: endpoint } : {}),
    ...(model ? { localLlmModel: model } : {}),
  });
  return sendSuccess(res, { success: true, message: 'Local LLM endpoint recorded (mock)', endpoint: url, model: model || appSettings.localLlmModel, result });
}));

app.post('/api/settings/test-smartthings', asyncHandler(async (_req, res) => {
  const summary = buildMockSmartThingsSummary();
  return sendSuccess(res, { success: true, message: 'SmartThings integration mocked', deviceCount: summary.devices.length, summary });
}));
app.get('/api/devices', asyncHandler(async (req, res) => {
  const { room, type, status, isOnline } = req.query || {};

  if (isDbConnected()) {
    const query = {};
    if (room) query.room = room;
    if (type) query.type = type;
    if (status !== undefined) query.status = status === 'true' || status === true;
    if (isOnline !== undefined) query.isOnline = isOnline === 'true' || isOnline === true;

    const docs = await DeviceModel.find(query).lean();
    return sendSuccess(res, { data: { devices: docs } });
  }

  let data = deepClone(memoryStore.devices);
  if (room) data = data.filter((device) => device.room === room);
  if (type) data = data.filter((device) => device.type === type);
  if (status !== undefined) data = data.filter((device) => String(device.status) === String(status));
  if (isOnline !== undefined) {
    data = data.filter((device) => String(!!device.status) === String(isOnline));
  }

  return sendSuccess(res, { data: { devices: data } });
}));

app.post('/api/devices', asyncHandler(async (req, res) => {
  const { name, type, room, status = false, brightness = 0, temperature } = req.body || {};
  if (!name || !type || !room) {
    return sendError(res, 400, 'name, type, and room are required');
  }

  if (isDbConnected()) {
    const doc = await DeviceModel.create({
      name,
      type,
      room,
      status: Boolean(status),
      brightness: type === 'light' ? Number(brightness ?? 0) : undefined,
      temperature: type === 'thermostat' ? Number(temperature ?? 72) : undefined,
    });
    return sendSuccess(res, { data: { device: doc.toObject() } }, 201);
  }

  const newDevice = {
    _id: generateId('dev'),
    name,
    type,
    room,
    status: Boolean(status),
    brightness: type === 'light' ? Number(brightness ?? 0) : undefined,
    temperature: type === 'thermostat' ? Number(temperature ?? 72) : undefined,
  };
  memoryStore.devices.push(newDevice);
  return sendSuccess(res, { data: { device: newDevice } }, 201);
}));

app.put('/api/devices/:id', asyncHandler(async (req, res) => {
  const updates = req.body || {};
  const { id } = req.params;

  if (isDbConnected()) {
    const doc = await DeviceModel.findByIdAndUpdate(id, updates, { new: true });
    if (!doc) {
      return sendError(res, 404, 'Device not found');
    }
    return sendSuccess(res, { message: 'Device updated', data: { device: doc.toObject() } });
  }

  const device = memoryStore.devices.find((d) => d._id === id);
  if (!device) {
    return sendError(res, 404, 'Device not found');
  }
  Object.assign(device, updates);
  return sendSuccess(res, { message: 'Device updated', data: { device } });
}));

app.delete('/api/devices/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (isDbConnected()) {
    const doc = await DeviceModel.findByIdAndDelete(id);
    if (!doc) {
      return sendError(res, 404, 'Device not found');
    }
    return sendSuccess(res, { message: 'Device removed', data: { device: doc.toObject() } });
  }

  const index = memoryStore.devices.findIndex((d) => d._id === id);
  if (index === -1) {
    return sendError(res, 404, 'Device not found');
  }
  const [removed] = memoryStore.devices.splice(index, 1);
  return sendSuccess(res, { message: 'Device removed', data: { device: removed } });
}));

app.post('/api/devices/control', asyncHandler(async (req, res) => {
  const { deviceId, action, value } = req.body || {};
  if (!deviceId || !action) {
    return sendError(res, 400, 'deviceId and action are required');
  }

  const applyChanges = (device) => {
    switch (action) {
      case 'turn_on':
        device.status = true;
        if (device.type === 'light' && device.brightness == null) device.brightness = 100;
        break;
      case 'turn_off':
        device.status = false;
        break;
      case 'set_brightness':
        if (device.type === 'light') {
          device.status = Number(value) > 0;
          device.brightness = Math.max(0, Math.min(100, Number(value)));
        }
        break;
      case 'set_temperature':
        if (device.type === 'thermostat') {
          device.temperature = Math.max(60, Math.min(85, Number(value)));
        }
        break;
      default:
        throw Object.assign(new Error('Unknown action'), { status: 400 });
    }
    return device;
  };

  if (isDbConnected()) {
    const device = await DeviceModel.findById(deviceId);
    if (!device) {
      return sendError(res, 404, 'Device not found');
    }
    applyChanges(device);
    await device.save();
    return sendSuccess(res, { data: { device: device.toObject() } });
  }

  const device = memoryStore.devices.find((d) => d._id === deviceId);
  if (!device) {
    return sendError(res, 404, 'Device not found');
  }
  applyChanges(device);
  return sendSuccess(res, { data: { device } });
}));

app.get('/api/devices/by-room', asyncHandler(async (req, res) => {
  if (isDbConnected()) {
    const devices = await DeviceModel.find().lean();
    const rooms = devices.reduce((acc, device) => {
      if (!acc[device.room]) acc[device.room] = [];
      acc[device.room].push(device);
      return acc;
    }, {});

    const payload = Object.entries(rooms).map(([name, list]) => ({ name, devices: list }));
    return sendSuccess(res, { data: { rooms: payload } });
  }

  const rooms = memoryStore.devices.reduce((acc, device) => {
    if (!acc[device.room]) acc[device.room] = [];
    acc[device.room].push(device);
    return acc;
  }, {});
  const payload = Object.entries(rooms).map(([name, list]) => ({ name, devices: list }));
  return sendSuccess(res, { data: { rooms: payload } });
}));

app.get('/api/devices/stats', asyncHandler(async (req, res) => {
  if (isDbConnected()) {
    const devices = await DeviceModel.find().lean();
    const total = devices.length;
    const online = devices.filter((d) => d.status).length;
    const byType = devices.reduce((acc, device) => {
      acc[device.type] = (acc[device.type] || 0) + 1;
      return acc;
    }, {});
    return sendSuccess(res, { data: { stats: { total, online, offline: total - online, byType } } });
  }

  const devices = memoryStore.devices;
  const total = devices.length;
  const online = devices.filter((d) => d.status).length;
  const byType = devices.reduce((acc, device) => {
    acc[device.type] = (acc[device.type] || 0) + 1;
    return acc;
  }, {});
  return sendSuccess(res, { data: { stats: { total, online, offline: total - online, byType } } });
}));

app.get('/api/devices/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (isDbConnected()) {
    const device = await DeviceModel.findById(id).lean();
    if (!device) {
      return sendError(res, 404, 'Device not found');
    }
    return sendSuccess(res, { data: { device } });
  }

  const device = memoryStore.devices.find((d) => d._id === id);
  if (!device) {
    return sendError(res, 404, 'Device not found');
  }
  return sendSuccess(res, { data: { device } });
}));
app.get('/api/scenes', asyncHandler(async (req, res) => {
  if (isDbConnected()) {
    const scenes = await SceneModel.find().lean();
    const formatted = scenes.map((scene) => ({
      ...scene,
      devices: scene.deviceActions?.map((action) => action.deviceId) || [],
    }));
    return sendSuccess(res, { scenes: formatted });
  }

  return sendSuccess(res, { scenes: deepClone(memoryStore.scenes) });
}));

app.post('/api/scenes/activate', asyncHandler(async (req, res) => {
  const { sceneId } = req.body || {};
  if (!sceneId) {
    return sendError(res, 400, 'sceneId is required');
  }

  if (isDbConnected()) {
    const scenes = await SceneModel.find();
    const scene = scenes.find((s) => s._id.toString() === sceneId);
    if (!scene) {
      return sendError(res, 404, 'Scene not found');
    }
    await Promise.all(scenes.map(async (doc) => {
      doc.active = doc._id.toString() === sceneId;
      await doc.save();
    }));
    return sendSuccess(res, { message: `Activated scene ${scene.name}` });
  }

  const scene = memoryStore.scenes.find((s) => s._id === sceneId);
  if (!scene) {
    return sendError(res, 404, 'Scene not found');
  }
  memoryStore.scenes = memoryStore.scenes.map((s) => ({ ...s, active: s._id === sceneId }));
  return sendSuccess(res, { message: `Activated scene ${scene.name}` });
}));

app.post('/api/scenes', asyncHandler(async (req, res) => {
  const { name, description = '', devices = [] } = req.body || {};
  if (!name) {
    return sendError(res, 400, 'Scene name is required');
  }

  if (isDbConnected()) {
    const scene = await SceneModel.create({
      name,
      description,
      deviceActions: (devices || []).map((deviceId) => ({ deviceId, action: 'turn_on' })),
      active: false,
    });
    return sendSuccess(res, { scene: { ...scene.toObject(), devices } }, 201);
  }

  const scene = {
    _id: generateId('scene'),
    name,
    description,
    devices,
    active: false,
  };
  memoryStore.scenes.push(scene);
  return sendSuccess(res, { scene }, 201);
}));
app.get('/api/automations', asyncHandler(async (req, res) => {
  if (isDbConnected()) {
    const docs = await AutomationModel.find().lean();
    return sendSuccess(res, { automations: docs });
  }
  return sendSuccess(res, { automations: deepClone(memoryStore.automations) });
}));

app.get('/api/automations/stats', asyncHandler(async (req, res) => {
  const computeStats = (list) => {
    const total = list.length;
    const enabled = list.filter((item) => item.enabled).length;
    const byCategory = list.reduce((acc, item) => {
      const key = item.category || 'custom';
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});
    return { total, enabled, disabled: total - enabled, byCategory };
  };

  if (isDbConnected()) {
    const docs = await AutomationModel.find().lean();
    return sendSuccess(res, { stats: computeStats(docs) });
  }
  return sendSuccess(res, { stats: computeStats(memoryStore.automations) });
}));

app.post('/api/automations', asyncHandler(async (req, res) => {
  const {
    name,
    description = '',
    trigger,
    actions,
    enabled = true,
    priority = 1,
    category = 'custom',
    conditions = [],
    cooldown = 0,
  } = req.body || {};

  if (!name || !trigger || !actions || !Array.isArray(actions) || !actions.length) {
    return sendError(res, 400, 'name, trigger, and at least one action are required');
  }

  if (isDbConnected()) {
    const doc = await AutomationModel.create({
      name,
      description,
      trigger,
      actions,
      enabled,
      priority,
      category,
      conditions,
      cooldown,
    });
    return sendSuccess(res, { automation: doc.toObject() }, 201);
  }

  const automation = {
    _id: generateId('auto'),
    name,
    description,
    trigger,
    actions,
    enabled,
    priority,
    category,
    conditions,
    cooldown,
    lastRun: null,
  };
  memoryStore.automations.push(automation);
  return sendSuccess(res, { automation }, 201);
}));

app.post('/api/automations/create-from-text', asyncHandler(async (req, res) => {
  const { text } = req.body || {};
  if (!text) {
    return sendError(res, 400, 'text is required');
  }

  const summary = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  const payload = {
    name: `Automation ${Date.now()}`,
    description: summary,
    trigger: { type: 'natural_language', conditions: { text } },
    actions: [{ type: 'notification', target: 'user', parameters: { message: summary } }],
    enabled: true,
    priority: 2,
    category: 'natural',
    conditions: [],
    cooldown: 0,
  };

  if (isDbConnected()) {
    const doc = await AutomationModel.create(payload);
    return sendSuccess(res, { automation: doc.toObject(), message: 'Automation generated from text' }, 201);
  }

  const automation = { _id: generateId('auto'), ...payload, lastRun: null };
  memoryStore.automations.push(automation);
  return sendSuccess(res, { automation, message: 'Automation generated from text' }, 201);
}));

app.put('/api/automations/:id/toggle', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { enabled } = req.body || {};

  if (isDbConnected()) {
    const doc = await AutomationModel.findById(id);
    if (!doc) {
      return sendError(res, 404, 'Automation not found');
    }
    doc.enabled = enabled !== undefined ? Boolean(enabled) : !doc.enabled;
    await doc.save();
    return sendSuccess(res, { message: 'Automation toggled', automation: doc.toObject() });
  }

  const automation = memoryStore.automations.find((item) => item._id === id);
  if (!automation) {
    return sendError(res, 404, 'Automation not found');
  }
  automation.enabled = enabled !== undefined ? Boolean(enabled) : !automation.enabled;
  return sendSuccess(res, { message: 'Automation toggled', automation });
}));

app.post('/api/automations/:id/execute', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (isDbConnected()) {
    const doc = await AutomationModel.findById(id);
    if (!doc) {
      return sendError(res, 404, 'Automation not found');
    }
    doc.lastRun = new Date();
    doc.executionCount = (doc.executionCount || 0) + 1;
    await doc.save();
    return sendSuccess(res, { message: `Executed ${doc.name}`, automation: doc.toObject(), executedActions: doc.actions.length });
  }

  const automation = memoryStore.automations.find((item) => item._id === id);
  if (!automation) {
    return sendError(res, 404, 'Automation not found');
  }
  automation.lastRun = new Date().toISOString();
  return sendSuccess(res, { message: `Executed ${automation.name}`, automation, executedActions: automation.actions.length });
}));

app.get('/api/automations/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (isDbConnected()) {
    const doc = await AutomationModel.findById(id).lean();
    if (!doc) {
      return sendError(res, 404, 'Automation not found');
    }
    return sendSuccess(res, { automation: doc });
  }

  const automation = memoryStore.automations.find((item) => item._id === id);
  if (!automation) {
    return sendError(res, 404, 'Automation not found');
  }
  return sendSuccess(res, { automation });
}));

app.put('/api/automations/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updates = req.body || {};

  if (isDbConnected()) {
    const doc = await AutomationModel.findByIdAndUpdate(id, updates, { new: true });
    if (!doc) {
      return sendError(res, 404, 'Automation not found');
    }
    return sendSuccess(res, { message: 'Automation updated', automation: doc.toObject() });
  }

  const automation = memoryStore.automations.find((item) => item._id === id);
  if (!automation) {
    return sendError(res, 404, 'Automation not found');
  }
  Object.assign(automation, updates);
  return sendSuccess(res, { message: 'Automation updated', automation });
}));

app.delete('/api/automations/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (isDbConnected()) {
    const doc = await AutomationModel.findByIdAndDelete(id);
    if (!doc) {
      return sendError(res, 404, 'Automation not found');
    }
    return sendSuccess(res, { message: 'Automation deleted', automation: doc.toObject() });
  }

  const index = memoryStore.automations.findIndex((item) => item._id === id);
  if (index === -1) {
    return sendError(res, 404, 'Automation not found');
  }
  const [removed] = memoryStore.automations.splice(index, 1);
  return sendSuccess(res, { message: 'Automation deleted', automation: removed });
}));
app.get('/api/voice/status', asyncHandler(async (req, res) => {
  if (isDbConnected()) {
    const devices = await VoiceDeviceModel.find().lean();
    const online = devices.filter((device) => device.status === 'online').length;
    const total = devices.length;
    return sendSuccess(res, {
      listening: true,
      connected: online > 0,
      activeDevices: online,
      totalDevices: total,
      deviceStats: {
        online,
        offline: total - online,
      },
    });
  }

  const devices = memoryStore.voiceDevices;
  const online = devices.filter((device) => device.status === 'online').length;
  return sendSuccess(res, {
    listening: true,
    connected: online > 0,
    activeDevices: online,
    totalDevices: devices.length,
    deviceStats: {
      online,
      offline: devices.length - online,
    },
  });
}));

app.get('/api/voice/devices', asyncHandler(async (req, res) => {
  if (isDbConnected()) {
    const docs = await VoiceDeviceModel.find().lean();
    return sendSuccess(res, { success: true, devices: docs, count: docs.length });
  }

  return sendSuccess(res, { success: true, devices: deepClone(memoryStore.voiceDevices), count: memoryStore.voiceDevices.length });
}));

app.post('/api/voice/test', asyncHandler(async (req, res) => {
  const { deviceId } = req.body || {};
  let deviceName = 'All Devices';
  let room = 'All Rooms';

  if (deviceId) {
    if (isDbConnected()) {
      const device = await VoiceDeviceModel.findById(deviceId).lean();
      if (device) {
        deviceName = device.name;
        room = device.room;
      }
    } else {
      const device = memoryStore.voiceDevices.find((item) => item._id === deviceId);
      if (device) {
        deviceName = device.name;
        room = device.room;
      }
    }
  }

  return sendSuccess(res, {
    success: true,
    message: 'Test played (demo)',
    deviceName,
    room,
    testResults: { ok: true },
  });
}));

app.get('/api/voice/devices/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (isDbConnected()) {
    const device = await VoiceDeviceModel.findById(id).lean();
    if (!device) {
      return sendError(res, 404, 'Device not found');
    }
    return sendSuccess(res, { success: true, device });
  }

  const device = memoryStore.voiceDevices.find((item) => item._id === id);
  if (!device) {
    return sendError(res, 404, 'Device not found');
  }
  return sendSuccess(res, { success: true, device });
}));

app.put('/api/voice/devices/:id/status', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};
  if (!status) {
    return sendError(res, 400, 'status is required');
  }

  if (isDbConnected()) {
    const doc = await VoiceDeviceModel.findByIdAndUpdate(id, { status }, { new: true });
    if (!doc) {
      return sendError(res, 404, 'Device not found');
    }
    return sendSuccess(res, { success: true, message: 'Status updated', device: doc.toObject() });
  }

  const device = memoryStore.voiceDevices.find((item) => item._id === id);
  if (!device) {
    return sendError(res, 404, 'Device not found');
  }
  device.status = status;
  return sendSuccess(res, { success: true, message: 'Status updated', device });
}));

app.get('/api/voice/devices/room/:room', asyncHandler(async (req, res) => {
  const room = decodeURIComponent(req.params.room);
  if (isDbConnected()) {
    const docs = await VoiceDeviceModel.find({ room }).lean();
    return sendSuccess(res, { success: true, devices: docs, room, count: docs.length });
  }

  const devices = memoryStore.voiceDevices.filter((device) => device.room === room);
  return sendSuccess(res, { success: true, devices, room, count: devices.length });
}));

app.get('/api/voice/devices/status/:status', asyncHandler(async (req, res) => {
  const status = req.params.status;
  if (isDbConnected()) {
    const docs = await VoiceDeviceModel.find({ status }).lean();
    return sendSuccess(res, { success: true, devices: docs, status, count: docs.length });
  }

  const devices = memoryStore.voiceDevices.filter((device) => device.status === status);
  return sendSuccess(res, { success: true, devices, status, count: devices.length });
}));

