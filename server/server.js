const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const http = require('http');
const mongoose = require('mongoose');
const fs = require('fs');
require('dotenv').config();

const { connectDB, closeDB } = require('./config/database');
const SettingsModel = require('./models/Settings');

let server;
let logServer;
let isShuttingDown = false;

// Create Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// Connect to DB (but don't crash the whole process if missing during first run)
// Connection is established during bootstrap() so we can await it safely.

// In-memory demo data so the UI can load
let devices = [
  { _id: 'dev-1', name: 'Living Room Lamp', type: 'light', room: 'Living Room', status: true, brightness: 70 },
  { _id: 'dev-2', name: 'Hallway Thermostat', type: 'thermostat', room: 'Hallway', status: true, temperature: 72 },
  { _id: 'dev-3', name: 'Front Door Lock', type: 'lock', room: 'Entry', status: true },
  { _id: 'dev-4', name: 'Bedroom Lamp', type: 'light', room: 'Bedroom', status: false, brightness: 0 },
];

let scenes = [
  { _id: 'scene-1', name: 'Movie Night', description: 'Dim lights, set temp to 70', devices: ['dev-1', 'dev-2'], active: false },
  { _id: 'scene-2', name: 'Good Morning', description: 'Turn on lights, set temp to 72', devices: ['dev-1', 'dev-4', 'dev-2'], active: false },
];

let voiceDevices = [
  { _id: 'voice-1', name: 'Kitchen Speaker', room: 'Kitchen', deviceType: 'speaker', status: 'online', lastSeen: new Date().toISOString(), powerSource: 'AC', connectionType: 'wifi', ipAddress: '192.168.1.20', volume: 60, microphoneSensitivity: 70, uptime: 3600 },
  { _id: 'voice-2', name: 'Bedroom Speaker', room: 'Bedroom', deviceType: 'speaker', status: 'offline', lastSeen: new Date(Date.now() - 3600_000).toISOString(), powerSource: 'AC', connectionType: 'wifi', volume: 40, microphoneSensitivity: 60, uptime: 0 },
];

let securityStatus = {
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
};


let securityAlarm = {
  _id: 'alarm-1',
  name: 'HomeBrain Security',
  alarmState: securityStatus.alarmState,
  isOnline: securityStatus.isOnline,
  smartthingsDeviceId: null,
  zones: [
    { deviceId: 'dev-3', name: 'Front Door', deviceType: 'lock', status: 'closed', bypassed: false, enabled: true, lastTriggered: null },
    { deviceId: 'st-device-3', name: 'Hallway Motion', deviceType: 'sensor', status: 'clear', bypassed: false, enabled: true, lastTriggered: null }
  ],
  lastArmed: securityStatus.lastArmed,
  lastDisarmed: securityStatus.lastDisarmed,
  armedBy: securityStatus.armedBy,
  disarmedBy: 'Demo User'
};

securityStatus.zoneCount = securityAlarm.zones.length;

// In-memory app settings (dev defaults)
let appSettings = {
  location: 'New York, NY',
  timezone: 'America/New_York',
  wakeWordSensitivity: 0.7,
  voiceVolume: 0.8,
  microphoneSensitivity: 0.6,
  enableVoiceConfirmation: true,
  enableNotifications: true,
  insteonPort: '/dev/ttyUSB0',
  smartthingsToken: '', // legacy
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

let smartthingsIntegration = {
  isConfigured: false,
  isConnected: false,
  clientId: '',
  clientSecret: '',
  redirectUri: '',
  deviceCount: 0,
};


let automations = [
  {
    _id: 'auto-1',
    name: 'Morning Wake Up',
    description: 'Gradually brighten the bedroom lights and warm the house before everyone wakes up.',
    trigger: { type: 'schedule', time: '07:00', days: ['mon','tue','wed','thu','fri'] },
    actions: [
      { deviceId: 'dev-4', action: 'set_brightness', value: 80 },
      { deviceId: 'dev-2', action: 'set_temperature', value: 72 }
    ],
    enabled: true,
    lastRun: null,
    category: 'schedule',
    priority: 2,
    conditions: [],
    cooldown: 0
  },
  {
    _id: 'auto-2',
    name: 'Goodnight Lockdown',
    description: 'Turn off common-area lights and lock doors when someone says goodnight.',
    trigger: { type: 'voice', phrase: 'goodnight', roomContext: 'any' },
    actions: [
      { deviceId: 'dev-1', action: 'turn_off' },
      { deviceId: 'dev-3', action: 'lock' }
    ],
    enabled: true,
    lastRun: null,
    category: 'voice',
    priority: 1,
    conditions: [{ type: 'time', after: '21:00' }],
    cooldown: 300
  },
  {
    _id: 'auto-3',
    name: 'Away Mode',
    description: 'Run when the home is set to away mode to keep the space secure.',
    trigger: { type: 'mode_change', mode: 'away' },
    actions: [
      { deviceId: 'dev-1', action: 'turn_off' },
      { deviceId: 'dev-4', action: 'turn_off' }
    ],
    enabled: false,
    lastRun: null,
    category: 'mode',
    priority: 3,
    conditions: [{ type: 'security', alarmState: 'armedAway' }],
    cooldown: 0
  }
];
let automationCounter = automations.length;

let voiceCommandHistory = [
  { _id: 'cmd-1', user: 'Matt', command: 'Turn on the living room lamp', deviceId: 'dev-1', status: 'success', timestamp: new Date(Date.now() - 45 * 60_000).toISOString() },
  { _id: 'cmd-2', user: 'Kate', command: 'Set thermostat to 72', deviceId: 'dev-2', status: 'success', timestamp: new Date(Date.now() - 2 * 60 * 60_000).toISOString() }
];

let userProfiles = [
  {
    _id: 'profile-1',
    name: 'Matt',
    wakeWords: ['Anna', 'Henry'],
    voiceId: 'voice_default_anna',
    voiceName: 'Anna',
    systemPrompt: 'You are Anna, a friendly smart home assistant who knows the household routine.',
    personality: 'friendly',
    responseStyle: 'concise',
    preferredLanguage: 'en-US',
    timezone: 'America/Denver',
    speechRate: 1.0,
    speechPitch: 1.0,
    permissions: ['lights', 'locks', 'thermostats', 'automations'],
    avatar: 'https://example.com/avatars/matt.png',
    contextMemory: true,
    learningMode: true,
    privacyMode: false,
    favorites: { devices: ['dev-1', 'dev-2'], scenes: ['scene-1'] },
    stats: { commandsIssued: 128, automationsCreated: 6, lastSeen: new Date(Date.now() - 15 * 60_000).toISOString() },
    active: true,
    createdAt: new Date(Date.now() - 10 * 24 * 60 * 60_000).toISOString(),
    updatedAt: new Date().toISOString()
  },
  {
    _id: 'profile-2',
    name: 'Guest',
    wakeWords: ['Home Brain'],
    voiceId: 'voice_default_ben',
    voiceName: 'Ben',
    systemPrompt: 'Respond warmly and guide new users through voice options.',
    personality: 'helper',
    responseStyle: 'detailed',
    preferredLanguage: 'en-US',
    timezone: 'America/Denver',
    speechRate: 1.05,
    speechPitch: 0.95,
    permissions: ['lights', 'scenes'],
    avatar: 'https://example.com/avatars/guest.png',
    contextMemory: false,
    learningMode: false,
    privacyMode: true,
    favorites: { devices: [], scenes: ['scene-2'] },
    stats: { commandsIssued: 12, automationsCreated: 0, lastSeen: new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString() },
    active: true,
    createdAt: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString(),
    updatedAt: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()
  }
];
let profileCounter = userProfiles.length;

const elevenLabsVoices = [
  { id: 'voice_default_anna', name: 'Anna', previewUrl: 'https://example.com/audio/anna-sample.mp3', category: 'assistant', labels: { accent: 'American', gender: 'female' }, description: 'Warm and upbeat daily assistant.' },
  { id: 'voice_default_ben', name: 'Ben', previewUrl: 'https://example.com/audio/ben-sample.mp3', category: 'assistant', labels: { accent: 'American', gender: 'male' }, description: 'Calm narrator voice ideal for confirmations.' },
  { id: 'voice_default_sophia', name: 'Sophia', previewUrl: 'https://example.com/audio/sophia-sample.mp3', category: 'multilingual', labels: { accent: 'Spanish', gender: 'female' }, description: 'Bilingual voice for Spanish responses.' }
];

let discoveryState = {
  enabled: true,
  lastScan: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
  autoApproveRooms: ['Kitchen', 'Living Room']
};

let discoveryPendingDevices = [
  { id: 'pending-1', name: 'Kitchen Satellite', type: 'speaker', macAddress: 'AA:BB:CC:DD:EE:01', ipAddress: '192.168.1.45', firmwareVersion: '1.0.3', capabilities: ['microphone', 'speaker', 'led'], timestamp: new Date(Date.now() - 90 * 1000).toISOString(), status: 'pending' },
  { id: 'pending-2', name: 'Office Button', type: 'button', macAddress: 'AA:BB:CC:DD:EE:02', ipAddress: '192.168.1.46', firmwareVersion: '1.1.0', capabilities: ['button', 'led'], timestamp: new Date(Date.now() - 4 * 60 * 1000).toISOString(), status: 'pending' }
];

let remoteDevices = [
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
    uptime: 12600,
    lastHeartbeat: new Date(Date.now() - 60 * 1000).toISOString(),
    registrationCode: null,
    createdAt: new Date(Date.now() - 5 * 24 * 60 * 60_000).toISOString(),
    updatedAt: new Date().toISOString()
  }
];

let remoteRegistrationRequests = [];

let smartthingsDevices = [
  { id: 'st-device-1', name: 'SmartThings Hub', label: 'Main Hub', room: 'Network Closet', deviceType: 'hub', components: ['main'], status: 'online', healthState: 'ONLINE', manufacturer: 'Samsung', model: 'STH-ETH-250', capabilities: ['bridge'], lastActivity: new Date(Date.now() - 5 * 60 * 1000).toISOString() },
  { id: 'st-device-2', name: 'Entry Light', label: 'Entry Pendant', room: 'Entry', deviceType: 'switch', components: ['main'], status: 'online', healthState: 'ONLINE', manufacturer: 'GE', model: 'SmartSwitch', capabilities: ['switch', 'switchLevel'], level: 60, lastActivity: new Date(Date.now() - 2 * 60 * 1000).toISOString() },
  { id: 'st-device-3', name: 'Hallway Sensor', label: 'Hall Motion', room: 'Hallway', deviceType: 'sensor', components: ['main'], status: 'online', healthState: 'ONLINE', manufacturer: 'Aeotec', model: 'MultiSensor', capabilities: ['motionSensor', 'temperatureMeasurement'], temperature: 70, motion: 'inactive', lastActivity: new Date(Date.now() - 15 * 60 * 1000).toISOString() }
];

let smartthingsScenes = [
  { id: 'st-scene-1', name: 'Good Morning', description: 'Turn on downstairs lights and start coffee.', room: 'Downstairs', lastExecuted: null },
  { id: 'st-scene-2', name: 'Good Night', description: 'Turn off lights and lock doors.', room: 'Whole Home', lastExecuted: null }
];

smartthingsIntegration.deviceCount = smartthingsDevices.length;


let smartthingsSthmConfig = { armAwayDeviceId: null, armStayDeviceId: null, disarmDeviceId: null, lastUpdated: null };

let insteonDevices = [
  { id: 'insteon-1', name: 'Garage Door Controller', room: 'Garage', deviceType: 'switch', status: 'online' }
];

function generateId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

const demoDefaults = {
  devices: deepClone(devices),
  scenes: deepClone(scenes),
  voiceDevices: deepClone(voiceDevices),
  automations: deepClone(automations),
  profiles: deepClone(userProfiles),
  smartthingsDevices: deepClone(smartthingsDevices),
  smartthingsScenes: deepClone(smartthingsScenes),
  discoveryPendingDevices: deepClone(discoveryPendingDevices),
  remoteDevices: deepClone(remoteDevices),
};


// --- Settings persistence helpers (DB if available, else JSON file) ---
const dataDir = path.join(__dirname, 'data');
const settingsFilePath = path.join(dataDir, 'settings.json');

function ensureDataDir() {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);
  } catch (e) {
    console.warn('Failed to ensure data directory:', e.message);
  }
}

function isDbConnected() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function readSettingsPersisted() {
  // Prefer DB if connected
  if (isDbConnected()) {
    try {
      const doc = await SettingsModel.getSettings();
      return doc.toObject();
    } catch (e) {
      console.warn('readSettingsPersisted(DB) failed, falling back to file:', e.message);
    }
  }
  // Fallback to file
  try {
    if (fs.existsSync(settingsFilePath)) {
      const raw = fs.readFileSync(settingsFilePath, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.warn('readSettingsPersisted(file) failed:', e.message);
  }
  // Fallback to current in-memory defaults
  return { ...appSettings };
}

async function writeSettingsPersisted(updates) {
  const current = await readSettingsPersisted();
  const sensitive = new Set(['elevenlabsApiKey','smartthingsToken','smartthingsClientSecret','openaiApiKey','anthropicApiKey']);
  const merged = { ...current, ...updates };
  const placeholderPattern = /^+/;

  for (const key of sensitive) {
    const incoming = updates[key];
    if (typeof incoming === 'string' && placeholderPattern.test(incoming)) {
      if (current[key] !== undefined) {
        merged[key] = current[key];
      } else {
        delete merged[key];
      }
    }
  }

  let persisted = merged;

  if (isDbConnected()) {
    try {
      const saved = await SettingsModel.updateSettings(merged);
      persisted = saved.toObject();
    } catch (e) {
      console.warn('writeSettingsPersisted(DB) failed, continuing with file persistence only:', e.message);
    }
  }

  try {
    ensureDataDir();
    fs.writeFileSync(settingsFilePath, JSON.stringify(persisted, null, 2), 'utf-8');
  } catch (e) {
    console.error('writeSettingsPersisted(file) failed:', e.message);
  }

  return persisted;
}
// Initialize in-memory appSettings from persisted store at startup

// Basic routes
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok' });
});

// Placeholder auth routes to allow client to proceed during initial setup
// In a full implementation, replace with real auth logic and JWT issuance
app.post('/api/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }
  // Return demo tokens and user payload so client can continue
  res.json({
    accessToken: 'demo-access-token',
    refreshToken: 'demo-refresh-token',
    email,
    role: 'user'
  });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });

app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out' });
});

app.post('/api/auth/refresh', (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return res.status(400).json({ success: false, message: 'refreshToken required' });
  }
  res.json({
    success: true,
    data: {
      accessToken: 'demo-access-token',
      refreshToken: 'demo-refresh-token'
    }
  });
});

  }
  res.json({
    accessToken: 'demo-access-token',
    refreshToken: 'demo-refresh-token',
    email,
    role: 'user'
  });
});

// Devices
app.get('/api/devices', (req, res) => {
  // basic filtering support
  const { room, type, status, isOnline } = req.query;
  let data = [...devices];
  if (room) data = data.filter(d => d.room === room);
  if (type) data = data.filter(d => d.type === type);
  if (status !== undefined) data = data.filter(d => String(d.status) === String(status));
  if (isOnline !== undefined) {
    // demo: treat status=true as online for non-voice devices
    data = data.filter(d => String(!!d.status) === String(isOnline));
  }
  res.json({ success: true, data: { devices: data } });
});

app.post('/api/devices/control', (req, res) => {
  const { deviceId, action, value } = req.body || {};
  const device = devices.find(d => d._id === deviceId);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });

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
        device.status = value > 0;
        device.brightness = Math.max(0, Math.min(100, Number(value)));
      }
      break;
    case 'set_temperature':
      if (device.type === 'thermostat') {
        device.temperature = Math.max(60, Math.min(85, Number(value)));
      }
      break;
    default:
      return res.status(400).json({ success: false, message: 'Unknown action' });
  }

  res.json({ success: true, data: { device } });
});

app.get('/api/devices/by-room', (req, res) => {
  const rooms = devices.reduce((acc, device) => {
    if (!acc[device.room]) acc[device.room] = [];
    acc[device.room].push(device);
    return acc;
  }, {});

  const payload = Object.entries(rooms).map(([name, list]) => ({
    name,
    devices: list
  }));

  res.json({ success: true, data: { rooms: payload } });
});




app.get('/api/devices/stats', (req, res) => {
  const total = devices.length;
  const online = devices.filter(d => d.status).length;
  const byType = devices.reduce((acc, d) => {
    acc[d.type] = (acc[d.type] || 0) + 1;
    return acc;
  }, {});

  res.json({
    success: true,
    data: {
      stats: {
        total,
        online,
        offline: total - online,
        byType
      }
    }
  });
});

app.get('/api/devices/:id', (req, res) => {
  const device = devices.find(d => d._id === req.params.id);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  res.json({ success: true, data: { device } });
});

app.post('/api/devices', (req, res) => {
  const { name, type, room, status = false, brightness = 0, temperature = 72 } = req.body || {};
  if (!name || !type || !room) {
    return res.status(400).json({ success: false, message: 'name, type, and room are required' });
  }

  const newDevice = {
    _id: generateId('dev'),
    name,
    type,
    room,
    status: Boolean(status),
    brightness: type === 'light' ? Number(brightness ?? 0) : undefined,
    temperature: type === 'thermostat' ? Number(temperature ?? 72) : undefined
  };
  devices.push(newDevice);
  res.status(201).json({ success: true, message: 'Device created', data: { device: newDevice } });
});

app.put('/api/devices/:id', (req, res) => {
  const device = devices.find(d => d._id === req.params.id);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  const updates = req.body || {};
  Object.assign(device, updates);
  res.json({ success: true, message: 'Device updated', data: { device } });
});

app.delete('/api/devices/:id', (req, res) => {
  const index = devices.findIndex(d => d._id === req.params.id);
  if (index === -1) return res.status(404).json({ success: false, message: 'Device not found' });
  const [removed] = devices.splice(index, 1);
  res.json({ success: true, message: 'Device removed', data: { device: removed } });
});




// Scenes
app.get('/api/scenes', (req, res) => {
  res.json({ scenes });
});

app.post('/api/scenes/activate', (req, res) => {
  const { sceneId } = req.body || {};
  const scene = scenes.find(s => s._id === sceneId);
  if (!scene) return res.status(404).json({ success: false, message: 'Scene not found' });

app.post('/api/scenes', (req, res) => {
  const { name, description = '', devices: deviceIds = [] } = req.body || {};
  if (!name) {
    return res.status(400).json({ success: false, message: 'Scene name is required' });

app.get('/api/automations', (req, res) => {
  res.json({ success: true, automations });
});

app.get('/api/automations/stats', (req, res) => {
  const total = automations.length;
  const enabled = automations.filter(a => a.enabled).length;
  const byCategory = automations.reduce((acc, automation) => {
    acc[automation.category] = (acc[automation.category] || 0) + 1;
    return acc;
  }, {});
  res.json({ success: true, stats: { total, enabled, disabled: total - enabled, byCategory } });
});

app.post('/api/automations', (req, res) => {
  const payload = req.body || {};
  if (!payload.name || !payload.trigger || !Array.isArray(payload.actions)) {
    return res.status(400).json({ success: false, message: 'name, trigger, and actions are required' });
  }
  const newAutomation = {
    _id: generateId('auto'),
    name: payload.name,
    description: payload.description || '',
    trigger: payload.trigger,
    actions: payload.actions,
    enabled: payload.enabled !== undefined ? Boolean(payload.enabled) : true,
    priority: payload.priority ?? 1,
    category: payload.category || 'custom',
    conditions: payload.conditions || [],
    cooldown: payload.cooldown || 0,
    lastRun: null
  };
  automations.push(newAutomation);
  automationCounter = automations.length;
  res.status(201).json({ success: true, message: 'Automation created', automation: newAutomation });
});

app.post('/api/automations/create-from-text', (req, res) => {
  const { text } = req.body || {};
  if (!text) {
    return res.status(400).json({ success: false, message: 'text is required' });
  }
  const summary = text.length > 60 ? `${text.slice(0, 57)}...` : text;
  const autoName = Automation ;
  const newAutomation = {
    _id: generateId('auto'),
    name: autoName,
    description: summary,
    trigger: { type: 'natural_language', text },
    actions: [{ action: 'notify', message: summary }],
    enabled: true,
    priority: 2,
    category: 'natural',
    conditions: [],
    cooldown: 0,
    lastRun: null
  };
  automations.push(newAutomation);
  automationCounter = automations.length;
  res.status(201).json({ success: true, automation: newAutomation, message: 'Automation generated from text' });
});

app.put('/api/automations/:id/toggle', (req, res) => {
  const automation = automations.find(a => a._id === req.params.id);
  if (!automation) return res.status(404).json({ success: false, message: 'Automation not found' });
  const enabled = req.body?.enabled;
  if (enabled === undefined) {
    automation.enabled = !automation.enabled;
  } else {
    automation.enabled = Boolean(enabled);
  }
  res.json({ success: true, message: 'Automation toggled', automation });
});

app.post('/api/automations/:id/execute', (req, res) => {
  const automation = automations.find(a => a._id === req.params.id);
  if (!automation) return res.status(404).json({ success: false, message: 'Automation not found' });
  automation.lastRun = new Date().toISOString();
  res.json({ success: true, message: Executed , automation, executedActions: automation.actions.length });
});

app.get('/api/automations/:id', (req, res) => {
  const automation = automations.find(a => a._id === req.params.id);
  if (!automation) return res.status(404).json({ success: false, message: 'Automation not found' });
  res.json({ success: true, automation });
});

app.put('/api/automations/:id', (req, res) => {
  const automation = automations.find(a => a._id === req.params.id);
  if (!automation) return res.status(404).json({ success: false, message: 'Automation not found' });
  Object.assign(automation, req.body || {});
  res.json({ success: true, message: 'Automation updated', automation });
});

app.delete('/api/automations/:id', (req, res) => {
  const index = automations.findIndex(a => a._id === req.params.id);
  if (index === -1) return res.status(404).json({ success: false, message: 'Automation not found' });

app.get('/api/profiles', (req, res) => {
  res.json({ success: true, profiles: userProfiles });
});

app.get('/api/profiles/voices', (req, res) => {
  res.json({ success: true, voices: elevenLabsVoices, count: elevenLabsVoices.length });
});

app.get('/api/profiles/voices/:voiceId', (req, res) => {
  const voice = elevenLabsVoices.find(v => v.id === req.params.voiceId);
  if (!voice) return res.status(404).json({ success: false, message: 'Voice not found' });
  res.json({ success: true, voice });
});

app.get('/api/profiles/wake-word/:wakeWord', (req, res) => {
  const word = req.params.wakeWord.toLowerCase();
  const matches = userProfiles.filter(profile => profile.wakeWords.some(w => w.toLowerCase() == word));
  res.json({ success: true, profiles: matches });
});

app.post('/api/profiles', (req, res) => {
  const payload = req.body || {};
  if (!payload.name || !payload.voiceId) {
    return res.status(400).json({ success: false, message: 'name and voiceId are required' });
  }
  const now = new Date().toISOString();
  const newProfile = {
    _id: generateId('profile'),
    name: payload.name,
    wakeWords: payload.wakeWords || [],
    voiceId: payload.voiceId,
    voiceName: payload.voiceName || payload.voiceId,
    systemPrompt: payload.systemPrompt || '',
    personality: payload.personality || 'friendly',
    responseStyle: payload.responseStyle || 'concise',
    preferredLanguage: payload.preferredLanguage || 'en-US',
    timezone: payload.timezone || appSettings.timezone,
    speechRate: payload.speechRate ?? 1,
    speechPitch: payload.speechPitch ?? 1,
    permissions: payload.permissions || [],
    avatar: payload.avatar || null,
    contextMemory: payload.contextMemory ?? false,
    learningMode: payload.learningMode ?? false,
    privacyMode: payload.privacyMode ?? false,
    favorites: payload.favorites || { devices: [], scenes: [] },
    stats: payload.stats || { commandsIssued: 0, automationsCreated: 0, lastSeen: now },
    active: payload.active ?? true,
    createdAt: now,
    updatedAt: now
  };
  userProfiles.push(newProfile);
  profileCounter = userProfiles.length;
  res.status(201).json({ success: true, profile: newProfile });
});

app.get('/api/profiles/:id', (req, res) => {
  const profile = userProfiles.find(p => p._id === req.params.id);
  if (!profile) return res.status(404).json({ success: false, message: 'Profile not found' });
  res.json({ success: true, profile });
});

app.put('/api/profiles/:id', (req, res) => {
  const profile = userProfiles.find(p => p._id === req.params.id);
  if (!profile) return res.status(404).json({ success: false, message: 'Profile not found' });
  Object.assign(profile, req.body || {});
  profile.updatedAt = new Date().toISOString();
  res.json({ success: true, message: 'Profile updated', profile });
});

app.delete('/api/profiles/:id', (req, res) => {
  const index = userProfiles.findIndex(p => p._id === req.params.id);
  if (index === -1) return res.status(404).json({ success: false, message: 'Profile not found' });
  const [removed] = userProfiles.splice(index, 1);
  res.json({ success: true, message: 'Profile deleted', profile: removed });
});

app.patch('/api/profiles/:id/toggle', (req, res) => {
  const profile = userProfiles.find(p => p._id === req.params.id);
  if (!profile) return res.status(404).json({ success: false, message: 'Profile not found' });
  profile.active = !profile.active;
  profile.updatedAt = new Date().toISOString();
  res.json({ success: true, message: 'Profile status toggled', profile });
});

app.patch('/api/profiles/:id/usage', (req, res) => {
  const profile = userProfiles.find(p => p._id === req.params.id);
  if (!profile) return res.status(404).json({ success: false, message: 'Profile not found' });
  profile.stats = profile.stats || { commandsIssued: 0, automationsCreated: 0, lastSeen: null };
  profile.stats.commandsIssued += 1;
  profile.stats.lastSeen = new Date().toISOString();
  res.json({ success: true, message: 'Profile usage updated', profile });
});

app.post('/api/profiles/:id/favorites/devices', (req, res) => {
  const profile = userProfiles.find(p => p._id === req.params.id);
  if (!profile) return res.status(404).json({ success: false, message: 'Profile not found' });
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ success: false, message: 'deviceId is required' });
  profile.favorites = profile.favorites || { devices: [], scenes: [] };
  if (!profile.favorites.devices.includes(deviceId)) {
    profile.favorites.devices.push(deviceId);
  }
  res.json({ success: true, message: 'Favorite device added', profile });
});

app.delete('/api/profiles/:id/favorites/devices/:deviceId', (req, res) => {
  const profile = userProfiles.find(p => p._id === req.params.id);
  if (!profile) return res.status(404).json({ success: false, message: 'Profile not found' });
  const { deviceId } = req.params;
  profile.favorites = profile.favorites || { devices: [], scenes: [] };
  profile.favorites.devices = profile.favorites.devices.filter(id => id !== deviceId);
  res.json({ success: true, message: 'Favorite device removed', profile });
});

  const [removed] = automations.splice(index, 1);
  res.json({ success: true, message: 'Automation deleted', deletedAutomation: removed });
});

  }

  const newScene = {
    _id: generateId('scene'),
    name,
    description,
    devices: Array.isArray(deviceIds) ? deviceIds : [],
    active: false
  };
  scenes.push(newScene);
  res.status(201).json({ success: true, scene: newScene });
});

  scenes = scenes.map(s => ({ ...s, active: s._id === sceneId }));
  res.json({ success: true, message: `Activated scene ${scene.name}` });
});

// Voice

app.post('/api/discovery/toggle', (req, res) => {
  const { enabled } = req.body || {};
  if (enabled === undefined) {
    discoveryState.enabled = !discoveryState.enabled;
  } else {
    discoveryState.enabled = Boolean(enabled);
  }
  discoveryState.lastScan = new Date().toISOString();
  res.json({ success: true, discovery: discoveryState });
});

app.get('/api/discovery/status', (req, res) => {
  res.json({ success: true, discovery: discoveryState, pendingCount: discoveryPendingDevices.length });
});

app.get('/api/discovery/pending', (req, res) => {
  res.json({ success: true, devices: discoveryPendingDevices });
});

app.post('/api/discovery/approve/:deviceId', (req, res) => {
  const pendingIndex = discoveryPendingDevices.findIndex(d => d.id === req.params.deviceId);
  if (pendingIndex === -1) return res.status(404).json({ success: false, message: 'Pending device not found' });
  const pending = discoveryPendingDevices.splice(pendingIndex, 1)[0];
  const { name, room, deviceType = pending.type || 'speaker' } = req.body || {};
  if (!name || !room) {
    discoveryPendingDevices.splice(pendingIndex, 0, pending);
    return res.status(400).json({ success: false, message: 'name and room are required to approve a device' });
  }
  const newVoiceDevice = {
    _id: generateId('voice'),
    name,
    room,
    deviceType,
    status: 'online',
    lastSeen: new Date().toISOString(),
    powerSource: pending.powerSource || 'AC',
    connectionType: 'wifi',
    ipAddress: pending.ipAddress,
    volume: 50,
    microphoneSensitivity: 60,
    firmwareVersion: pending.firmwareVersion || '1.0.0',
    uptime: 0
  };
  voiceDevices.push(newVoiceDevice);
  res.json({ success: true, message: 'Device approved', device: newVoiceDevice, pending: discoveryPendingDevices });
});

app.post('/api/discovery/reject/:deviceId', (req, res) => {
  const index = discoveryPendingDevices.findIndex(d => d.id === req.params.deviceId);
  if (index === -1) return res.status(404).json({ success: false, message: 'Pending device not found' });
  const [removed] = discoveryPendingDevices.splice(index, 1);
  res.json({ success: true, message: 'Device rejected', device: removed, pending: discoveryPendingDevices });
});

app.post('/api/discovery/clear-pending', (req, res) => {
  const cleared = discoveryPendingDevices.length;
  discoveryPendingDevices = [];
  res.json({ success: true, message: `Cleared ${cleared} pending devices`, removed: cleared });
});


app.get('/api/remote-devices/setup-instructions', (req, res) => {
  res.json({
    success: true,
    instructions: {
      summary: 'Install the HomeBrain satellite package, configure WiFi, then register the device using the provided code.',
      steps: [
        'Flash the latest HomeBrain satellite firmware to the ESP32 device.',
        'Power on the device and connect to the HomeBrain-Setup WiFi network.',
        'Visit http://setup.local and enter your home WiFi credentials.',
        'In the HomeBrain dashboard, register the device to receive a 6-digit code.',
        'Enter the registration code on the device to complete pairing.'
      ],
      downloads: [
        { name: 'Satellite Firmware v1.0.3', url: 'https://example.com/firmware/homebrain-satellite.bin' },
        { name: 'Setup Guide', url: 'https://example.com/docs/satellite-setup.pdf' }
      ]
    }
  });
});

app.post('/api/remote-devices/register', (req, res) => {
  const { name, room, deviceType = 'satellite', macAddress = null } = req.body || {};
  if (!name || !room) {
    return res.status(400).json({ success: false, message: 'name and room are required' });
  }
  const registrationCode = Math.random().toString().slice(2, 8);
  const request = {
    id: generateId('reg'),
    name,
    room,
    deviceType,
    macAddress,
    registrationCode,
    requestedAt: new Date().toISOString()
  };
  remoteRegistrationRequests.push(request);
  res.status(201).json({ success: true, device: request, registrationCode, message: 'Registration code generated' });
});

app.post('/api/remote-devices/activate', (req, res) => {
  const { registrationCode, ipAddress, firmwareVersion } = req.body || {};
  if (!registrationCode) {
    return res.status(400).json({ success: false, message: 'registrationCode is required' });
  }
  const requestIndex = remoteRegistrationRequests.findIndex(r => r.registrationCode === registrationCode);
  if (requestIndex === -1) {
    return res.status(404).json({ success: false, message: 'Registration code not found or expired' });
  }
  const request = remoteRegistrationRequests.splice(requestIndex, 1)[0];
  const now = new Date().toISOString();
  const device = {
    _id: generateId('remote'),
    name: request.name,
    room: request.room,
    deviceType: request.deviceType,
    status: 'online',
    ipAddress: ipAddress || '0.0.0.0',
    macAddress: request.macAddress,
    firmwareVersion: firmwareVersion || '1.0.0',
    batteryLevel: null,
    uptime: 0,
    lastHeartbeat: now,
    registrationCode: null,
    createdAt: now,
    updatedAt: now
  };
  remoteDevices.push(device);
  res.json({ success: true, device, hubUrl: 'http://homebrain.local', message: 'Device activated' });
});

app.get('/api/remote-devices/:deviceId/config', (req, res) => {
  const device = remoteDevices.find(d => d._id === req.params.deviceId);
  if (!device) return res.status(404).json({ success: false, message: 'Remote device not found' });
  res.json({ success: true, device, config: { mqttTopic: `homebrain/${device._id}`, heartbeatInterval: 30 } });
});

app.post('/api/remote-devices/:deviceId/heartbeat', (req, res) => {
  const device = remoteDevices.find(d => d._id === req.params.deviceId);
  if (!device) return res.status(404).json({ success: false, message: 'Remote device not found' });
  const { status, batteryLevel, uptime, lastInteraction } = req.body || {};
  if (status) device.status = status;
  if (batteryLevel !== undefined) device.batteryLevel = batteryLevel;
  if (uptime !== undefined) device.uptime = uptime;
  device.lastHeartbeat = new Date().toISOString();
  if (lastInteraction) device.lastInteraction = lastInteraction;
  device.updatedAt = new Date().toISOString();
  res.json({ success: true, message: 'Heartbeat updated' });
});

app.delete('/api/remote-devices/:deviceId', (req, res) => {
  const index = remoteDevices.findIndex(d => d._id === req.params.deviceId);
  if (index === -1) return res.status(404).json({ success: false, message: 'Remote device not found' });
  const [removed] = remoteDevices.splice(index, 1);
  res.json({ success: true, message: 'Remote device deleted', device: removed });
});

app.get('/api/voice/status', (req, res) => {
  const online = voiceDevices.filter(v => v.status === 'online').length;
  res.json({
    listening: true,
    connected: online > 0,
    activeDevices: online,
    totalDevices: voiceDevices.length,
    deviceStats: {
      online,
      offline: voiceDevices.length - online,
    }
  });
});

app.get('/api/voice/devices', (req, res) => {
  res.json({ success: true, devices: voiceDevices, count: voiceDevices.length });
});

// Security alarm
app.get('/api/security-alarm', (req, res) => {
  res.json({ success: true, alarm: securityAlarm });
});

app.get('/api/security-alarm/status', (req, res) => {
  res.json({ success: true, status: securityStatus });
});

app.post('/api/security-alarm/arm', (req, res) => {
  const { mode } = req.body || {};
  const now = new Date().toISOString();
  securityStatus.alarmState = mode === 'away' ? 'armedAway' : 'armedStay';
  securityStatus.isArmed = true;
  securityStatus.isTriggered = false;
  securityStatus.lastArmed = now;
  securityStatus.armedBy = 'Demo User';
  res.json({ success: true, message: `System armed (${mode})`, alarm: { alarmState: securityStatus.alarmState } });
});

app.post('/api/security-alarm/disarm', (req, res) => {
  const now = new Date().toISOString();
  securityStatus.alarmState = 'disarmed';
  securityStatus.isArmed = false;
  securityStatus.isTriggered = false;
  securityStatus.lastDisarmed = now;
  res.json({ success: true, message: 'System disarmed', alarm: { alarmState: securityStatus.alarmState } });
});

app.post('/api/security-alarm/sync', (req, res) => {
  // Demo: pretend to sync with SmartThings
  res.json({ success: true, message: 'Synced with SmartThings', alarm: { _id: 'alarm-1', alarmState: securityStatus.alarmState, isOnline: securityStatus.isOnline } });
});


app.put('/api/security-alarm/configure', (req, res) => {
  const { smartthingsDeviceId = null } = req.body || {};
  securityAlarm.smartthingsDeviceId = smartthingsDeviceId;
  res.json({ success: true, message: 'Security integration updated', alarm: securityAlarm });
});

app.post('/api/security-alarm/zones', (req, res) => {
  const { name, deviceId, deviceType, enabled = true, bypassable = true } = req.body || {};
  if (!name || !deviceId || !deviceType) {
    return res.status(400).json({ success: false, message: 'name, deviceId, and deviceType are required' });
  }
  const zone = {
    zoneId: generateId('zone'),
    name,
    deviceId,
    deviceType,
    enabled: Boolean(enabled),
    bypassable: Boolean(bypassable),
    bypassed: false,
    status: 'clear',
    lastTriggered: null
  };
  securityAlarm.zones.push(zone);
  securityStatus.zoneCount = securityAlarm.zones.length;
  res.status(201).json({ success: true, message: 'Zone added', alarm: securityAlarm });
});

app.delete('/api/security-alarm/zones/:deviceId', (req, res) => {
  const index = securityAlarm.zones.findIndex(z => z.deviceId === req.params.deviceId);
  if (index === -1) return res.status(404).json({ success: false, message: 'Zone not found' });
  const [removed] = securityAlarm.zones.splice(index, 1);
  securityStatus.zoneCount = securityAlarm.zones.length;
  res.json({ success: true, message: 'Zone removed', alarm: securityAlarm, zone: removed });
});

app.put('/api/security-alarm/zones/:deviceId/bypass', (req, res) => {
  const zone = securityAlarm.zones.find(z => z.deviceId === req.params.deviceId);
  if (!zone) return res.status(404).json({ success: false, message: 'Zone not found' });
  zone.bypassed = Boolean(req.body?.bypass);
  res.json({ success: true, message: 'Zone bypass updated', alarm: securityAlarm });
});

// Settings
app.get('/api/settings', (req, res) => {
  // Mask sensitive fields when returning
  const masked = {
    ...appSettings,
    elevenlabsApiKey: appSettings.elevenlabsApiKey ? '************************' : '',
    smartthingsToken: appSettings.smartthingsToken ? '************************' : '',
    smartthingsClientSecret: appSettings.smartthingsClientSecret ? '************************' : '',
    openaiApiKey: appSettings.openaiApiKey ? '************************' : '',
    anthropicApiKey: appSettings.anthropicApiKey ? '************************' : '',
  };
  res.json({ success: true, settings: masked });
});

app.put('/api/settings', async (req, res) => {
  try {
    const updates = req.body || {};
    const saved = await writeSettingsPersisted(updates);
    // Refresh in-memory settings
    appSettings = { ...appSettings, ...saved };
    res.json({ success: true, message: 'Settings updated', settings: appSettings });
  } catch (e) {
    console.error('PUT /api/settings failed:', e);
    res.status(500).json({ success: false, message: 'Failed to update settings' });
  }
});

app.get('/api/settings/:key', (req, res) => {
  const key = req.params.key;
  if (!(key in appSettings)) return res.status(404).json({ success: false, message: 'Setting not found' });
  res.json({ success: true, key, value: appSettings[key] });
});

// SmartThings mock endpoints used by Settings page
app.get('/api/smartthings/status', (req, res) => {
  res.json({ success: true, integration: smartthingsIntegration });
});

app.post('/api/smartthings/configure', (req, res) => {
  const { clientId, clientSecret, redirectUri } = req.body || {};
  if (!clientId || !clientSecret) return res.status(400).json({ success: false, message: 'Client ID and secret required' });
  smartthingsIntegration.isConfigured = true;
  smartthingsIntegration.clientId = clientId;
  smartthingsIntegration.clientSecret = clientSecret ? '************************' : '';
  smartthingsIntegration.redirectUri = redirectUri || '';
  res.json({ success: true, message: 'SmartThings OAuth configured' });
});

app.get('/api/smartthings/auth/url', (req, res) => {
  if (!smartthingsIntegration.isConfigured) return res.status(400).json({ success: false, message: 'OAuth not configured' });
  // For demo, just echo a placeholder URL
  res.json({ success: true, authUrl: 'https://account.smartthings.com/oauth/authorize?demo=true' });
});

app.post('/api/smartthings/test', (req, res) => {
  // Pretend test succeeded
  res.json({ success: true, message: 'SmartThings connection OK', deviceCount: smartthingsIntegration.deviceCount });
});

app.post('/api/smartthings/disconnect', (req, res) => {
  smartthingsIntegration = { isConfigured: false, isConnected: false, clientId: '', clientSecret: '', redirectUri: '', deviceCount: 0 };
  res.json({ success: true, message: 'SmartThings disconnected' });

app.get('/api/smartthings/devices', (req, res) => {
  res.json({ success: true, devices: smartthingsDevices, count: smartthingsDevices.length });
});

app.get('/api/smartthings/devices/:deviceId', (req, res) => {
  const device = smartthingsDevices.find(d => d.id === req.params.deviceId);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  res.json({ success: true, device });
});

app.get('/api/smartthings/devices/:deviceId/status', (req, res) => {
  const device = smartthingsDevices.find(d => d.id === req.params.deviceId);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  res.json({ success: true, status: { health: device.healthState || 'ONLINE', lastActivity: device.lastActivity } });
});

app.post('/api/smartthings/devices/:deviceId/commands', (req, res) => {
  const device = smartthingsDevices.find(d => d.id === req.params.deviceId);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  res.json({ success: true, result: { accepted: true, commands: req.body?.commands || [] } });
});

app.post('/api/smartthings/devices/:deviceId/on', (req, res) => {
  const device = smartthingsDevices.find(d => d.id === req.params.deviceId);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  device.status = 'online';
  device.on = true;
  res.json({ success: true, result: { status: 'on' }, device });
});

app.post('/api/smartthings/devices/:deviceId/off', (req, res) => {
  const device = smartthingsDevices.find(d => d.id === req.params.deviceId);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  device.status = 'offline';
  device.on = false;
  res.json({ success: true, result: { status: 'off' }, device });
});

app.post('/api/smartthings/devices/:deviceId/level', (req, res) => {
  const device = smartthingsDevices.find(d => d.id === req.params.deviceId);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  const { level } = req.body || {};
  device.level = Math.max(0, Math.min(100, Number(level ?? device.level ?? 0)));
  res.json({ success: true, result: { level: device.level }, device });
});

app.get('/api/smartthings/scenes', (req, res) => {
  res.json({ success: true, scenes: smartthingsScenes });
});

app.post('/api/smartthings/scenes/:sceneId/execute', (req, res) => {
  const scene = smartthingsScenes.find(s => s.id === req.params.sceneId);
  if (!scene) return res.status(404).json({ success: false, message: 'Scene not found' });
  scene.lastExecuted = new Date().toISOString();
  res.json({ success: true, result: { executedAt: scene.lastExecuted }, scene });
});

app.post('/api/smartthings/sthm/configure', (req, res) => {
  const { armAwayDeviceId = null, armStayDeviceId = null, disarmDeviceId = null } = req.body || {};
  smartthingsSthmConfig = { armAwayDeviceId, armStayDeviceId, disarmDeviceId, lastUpdated: new Date().toISOString() };
  res.json({ success: true, message: 'STHM virtual switches configured', config: smartthingsSthmConfig });
});

function updateSecurityState(mode) {
  if (mode === 'disarm') {
    securityStatus.alarmState = 'disarmed';
    securityStatus.isArmed = false;
  } else {
    securityStatus.alarmState = mode === 'away' ? 'armedAway' : 'armedStay';
    securityStatus.isArmed = true;
  }
  const now = new Date().toISOString();
  if (mode === 'disarm') {
    securityStatus.lastDisarmed = now;
  } else {
    securityStatus.lastArmed = now;
  }
  securityAlarm.alarmState = securityStatus.alarmState;
}

app.post('/api/smartthings/sthm/arm-stay', (req, res) => {
  updateSecurityState('stay');
  res.json({ success: true, result: { mode: 'stay' }, alarm: securityStatus });
});

app.post('/api/smartthings/sthm/arm-away', (req, res) => {
  updateSecurityState('away');
  res.json({ success: true, result: { mode: 'away' }, alarm: securityStatus });
});

app.post('/api/smartthings/sthm/disarm', (req, res) => {
  updateSecurityState('disarm');
  res.json({ success: true, result: { mode: 'disarm' }, alarm: securityStatus });
});


});

// Maintenance mock endpoints used by Settings page



const respondSmartThingsSync = (res) => {
  smartthingsDevices = deepClone(demoDefaults.smartthingsDevices);
  smartthingsIntegration.deviceCount = smartthingsDevices.length;
  res.json({ success: true, deviceCount: smartthingsIntegration.deviceCount });
};

const respondInsteonSync = (res) => {
  res.json({ success: true, message: 'INSTEON sync started (demo)' });
};

const resetMaintenanceSettings = (req, res) => {
  appSettings.enableSecurityMode = false;
  res.json({ success: true });
};

app.post('/api/maintenance/clear-fake-data', (req, res) => {
  const results = {
    devices: devices.length,
    scenes: scenes.length,
    automations: automations.length,
    voiceDevices: voiceDevices.length,
    userProfiles: userProfiles.length,
    remoteDevices: remoteDevices.length,
    smartthingsDevices: smartthingsDevices.length,
  };
  devices = [];
  scenes = [];
  automations = [];
  voiceDevices = [];
  userProfiles = [];
  remoteDevices = [];
  smartthingsDevices = [];
  smartthingsScenes = [];
  discoveryPendingDevices = [];
  smartthingsIntegration.deviceCount = 0;
  res.json({ success: true, message: 'Demo data cleared', results });
});

app.post('/api/maintenance/inject-fake-data', (req, res) => {
  devices = deepClone(demoDefaults.devices);
  scenes = deepClone(demoDefaults.scenes);
  automations = deepClone(demoDefaults.automations);
  voiceDevices = deepClone(demoDefaults.voiceDevices);
  userProfiles = deepClone(demoDefaults.profiles);
  remoteDevices = deepClone(demoDefaults.remoteDevices);
  smartthingsDevices = deepClone(demoDefaults.smartthingsDevices);
  smartthingsScenes = deepClone(demoDefaults.smartthingsScenes);
  discoveryPendingDevices = deepClone(demoDefaults.discoveryPendingDevices);
  smartthingsIntegration.deviceCount = smartthingsDevices.length;
  res.json({ success: true, message: 'Demo data injected', results: {
    devices: devices.length,
    scenes: scenes.length,
    automations: automations.length,
    voiceDevices: voiceDevices.length,
    userProfiles: userProfiles.length
  }});
});

app.post('/api/maintenance/smartthings/sync', (req, res) => respondSmartThingsSync(res));
app.post('/api/maintenance/insteon/sync', (req, res) => respondInsteonSync(res));

app.post('/api/maintenance/smartthings/clear-devices', (req, res) => {
  const deletedCount = smartthingsDevices.length;
  smartthingsDevices = [];
  smartthingsIntegration.deviceCount = 0;
  res.json({ success: true, deletedCount });
});

app.post('/api/maintenance/reset-settings', resetMaintenanceSettings);
app.post('/api/maintenance/reset/settings', resetMaintenanceSettings);

app.post('/api/maintenance/smartthings/clear', (req, res) => {
  smartthingsIntegration = { isConfigured: false, isConnected: false, clientId: '', clientSecret: '', redirectUri: '', deviceCount: 0 };
  smartthingsDevices = [];
  smartthingsScenes = [];
  res.json({ success: true });
});

app.post('/api/maintenance/voice/clear', (req, res) => {
  const deletedCount = voiceCommandHistory.length;
  voiceCommandHistory = [];
  res.json({ success: true, deletedCount });
});

app.get('/api/maintenance/health', (req, res) => {
  const onlineVoices = voiceDevices.filter(v => v.status === 'online').length;
  res.json({
    success: true,
    health: {
      database: {
        collections: {
          devices: devices.length,
          scenes: scenes.length,
          automations: automations.length,
          voiceDevices: voiceDevices.length,
          userProfiles: userProfiles.length,
        }
      },
      devices: {
        total: devices.length,
        online: devices.filter(d => d.status).length,
        offline: devices.filter(d => !d.status).length,
      },
      voiceSystem: {
        online: onlineVoices,
        devices: voiceDevices.length,
      },
      integrations: {
        smartthings: { connected: smartthingsIntegration.isConnected, devices: smartthingsDevices.length },
        insteon: { connected: false }
      }
    }
  });
});

app.delete('/api/maintenance/fake-data', (req, res) => {
  const results = {
    devices: devices.length,
    scenes: scenes.length,
    automations: automations.length,
    voiceDevices: voiceDevices.length,
    userProfiles: userProfiles.length
  };
  devices = [];
  scenes = [];
  automations = [];
  voiceDevices = [];
  userProfiles = [];
  res.json({ success: true, message: 'Demo data cleared', results });
});

app.post('/api/maintenance/fake-data', (req, res) => {
  devices = deepClone(demoDefaults.devices);
  scenes = deepClone(demoDefaults.scenes);
  automations = deepClone(demoDefaults.automations);
  voiceDevices = deepClone(demoDefaults.voiceDevices);
  userProfiles = deepClone(demoDefaults.profiles);
  res.json({ success: true, message: 'Demo data restored' });
});

app.post('/api/maintenance/sync/smartthings', (req, res) => respondSmartThingsSync(res));
app.post('/api/maintenance/sync/insteon', (req, res) => respondInsteonSync(res));

app.delete('/api/maintenance/devices/smartthings', (req, res) => {
  const deletedCount = smartthingsDevices.length;
  smartthingsDevices = [];
  smartthingsIntegration.deviceCount = 0;
  res.json({ success: true, deletedCount });
});

app.delete('/api/maintenance/devices/insteon', (req, res) => {
  const deletedCount = insteonDevices.length;
  insteonDevices = [];
  res.json({ success: true, deletedCount });
});

app.delete('/api/maintenance/integrations/smartthings', (req, res) => {
  smartthingsIntegration = { isConfigured: false, isConnected: false, clientId: '', clientSecret: '', redirectUri: '', deviceCount: 0 };
  res.json({ success: true, message: 'SmartThings integration cleared' });
});

app.delete('/api/maintenance/voice-commands', (req, res) => {
  const deletedCount = voiceCommandHistory.length;
  voiceCommandHistory = [];
  res.json({ success: true, message: 'Voice command history cleared', deletedCount });
});

app.get('/api/maintenance/export', (req, res) => {
  const config = {
    appSettings,
    smartthingsIntegration,
    devices,
    scenes,
    automations,
    voiceDevices,
    userProfiles,
    smartthingsDevices,
    smartthingsScenes
  };
  res.json({ success: true, message: 'Export generated', config });
});



// Settings test endpoints
app.post('/api/settings/test-smartthings', (req, res) => {
  const { useOAuth } = req.body || {};
  res.json({ success: true, message: useOAuth ? 'SmartThings OAuth settings look good' : 'SmartThings token validated', deviceCount: smartthingsDevices.length });
});

app.post('/api/settings/test-elevenlabs', (req, res) => {
  const { apiKey } = req.body || {};
  if (!apiKey) return res.status(400).json({ success: false, message: 'apiKey required' });
  res.json({ success: true, message: 'ElevenLabs key OK (demo)', voiceCount: 5 });
});

app.post('/api/settings/test-openai', (req, res) => {
  const { apiKey, model } = req.body || {};
  if (!apiKey) return res.status(400).json({ success: false, message: 'apiKey required' });
  res.json({ success: true, message: 'OpenAI key OK (demo)', model: model || appSettings.openaiModel });
});

app.post('/api/settings/test-anthropic', (req, res) => {
  const { apiKey, model } = req.body || {};
  if (!apiKey) return res.status(400).json({ success: false, message: 'apiKey required' });
  res.json({ success: true, message: 'Anthropic key OK (demo)', model: model || appSettings.anthropicModel });
});

app.post('/api/settings/test-local-llm', (req, res) => {
  const { endpoint, model } = req.body || {};
  if (!endpoint) return res.status(400).json({ success: false, message: 'endpoint required' });
  res.json({ success: true, message: 'Local LLM reachable (demo)', endpoint, model: model || appSettings.localLlmModel });
});

// Additional voice endpoints for completeness
app.post('/api/voice/test', (req, res) => {
  const { deviceId } = req.body || {};
  const device = deviceId ? voiceDevices.find(v => v._id === deviceId) : null;
  res.json({ success: true, message: 'Test played (demo)', deviceName: device?.name || 'All Devices', room: device?.room || 'All Rooms', testResults: { ok: true } });
});


app.get('/api/elevenlabs/voices', (req, res) => {
  res.json({ success: true, voices: elevenLabsVoices, count: elevenLabsVoices.length });
});

app.get('/api/elevenlabs/voices/:voiceId', (req, res) => {
  const voice = elevenLabsVoices.find(v => v.id === req.params.voiceId);
  if (!voice) return res.status(404).json({ success: false, message: 'Voice not found' });
  res.json({ success: true, voice });
});

app.post('/api/elevenlabs/voices/:voiceId/validate', (req, res) => {
  const voice = elevenLabsVoices.find(v => v.id === req.params.voiceId);
  res.json({ success: true, valid: Boolean(voice), voiceId: req.params.voiceId });
});

function sendMockAudio(res) {
  const audioBuffer = Buffer.from('ID3mock-homebrain-audio');
  res.set('Content-Type', 'audio/mpeg');
  res.send(audioBuffer);
}

app.post('/api/elevenlabs/text-to-speech', (req, res) => {
  sendMockAudio(res);
});

app.post('/api/elevenlabs/preview', (req, res) => {
  sendMockAudio(res);
});

app.get('/api/elevenlabs/status', (req, res) => {
  const configured = Boolean(appSettings.elevenlabsApiKey);
  res.json({
    success: true,
    status: {
      configured,
      apiKeyValid: configured,
      totalVoices: elevenLabsVoices.length,
      service: 'ElevenLabs',
      baseUrl: 'https://api.elevenlabs.io'
    }
  });
});

app.get('/api/voice/devices/:id', (req, res) => {
  const device = voiceDevices.find(v => v._id === req.params.id);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  res.json({ success: true, device });
});

app.put('/api/voice/devices/:id/status', (req, res) => {
  const device = voiceDevices.find(v => v._id === req.params.id);
  if (!device) return res.status(404).json({ success: false, message: 'Device not found' });
  const { status } = req.body || {};
  device.status = status || device.status;
  res.json({ success: true, message: 'Status updated', device });
});

app.get('/api/voice/devices/room/:room', (req, res) => {
  const room = decodeURIComponent(req.params.room);
  const devicesInRoom = voiceDevices.filter(v => v.room === room);
  res.json({ success: true, devices: devicesInRoom, room, count: devicesInRoom.length });
});

app.get('/api/voice/devices/status/:status', (req, res) => {
  const status = req.params.status;
  const list = voiceDevices.filter(v => v.status === status);
  res.json({ success: true, devices: list, status, count: list.length });
});

// Lightweight log sink to silence localhost:4444/logs POSTs
app.post('/logs', (req, res) => {
  // No-op: accept any log payload and return 204
  res.status(204).end();
});

// Start HTTP servers
async function bootstrap() {
  try {
    await connectDB();
    const persisted = await readSettingsPersisted();
    appSettings = { ...appSettings, ...persisted };

    const PORT = process.env.PORT || 3000;
    server = http.createServer(app);
    await new Promise(resolve => server.listen(PORT, resolve));
    console.log(`HomeBrain API listening on port ${PORT}`);

    const LOG_PORT = Number(process.env.LOG_PORT || 4444);
    logServer = http.createServer(app);
    await new Promise(resolve => logServer.listen(LOG_PORT, resolve));
    console.log(`Log sink listening on port ${LOG_PORT}`);
  } catch (err) {
    console.error('Failed to bootstrap HomeBrain server:', err);
    process.exit(1);
  }
}

bootstrap();

async function shutdown() {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  try {
    if (server) {
      await new Promise(resolve => server.close(resolve));
      console.log('HTTP server closed');
    }
    if (logServer) {
      await new Promise(resolve => logServer.close(resolve));
      console.log('Log server closed');
    }
    await closeDB();
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  shutdown();
});


process.on('SIGTERM', () => {
  shutdown();
});


