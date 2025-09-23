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

// Scenes
app.get('/api/scenes', (req, res) => {
  res.json({ scenes });
});

app.post('/api/scenes/activate', (req, res) => {
  const { sceneId } = req.body || {};
  const scene = scenes.find(s => s._id === sceneId);
  if (!scene) return res.status(404).json({ success: false, message: 'Scene not found' });
  scenes = scenes.map(s => ({ ...s, active: s._id === sceneId }));
  res.json({ success: true, message: `Activated scene ${scene.name}` });
});

// Voice
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
});

// Maintenance mock endpoints used by Settings page
app.post('/api/maintenance/clear-fake-data', (req, res) => {
  const results = { devices: devices.length, scenes: scenes.length, voiceDevices: voiceDevices.length };
  devices = [];
  scenes = [];
  voiceDevices = [];
  res.json({ success: true, results });
});

app.post('/api/maintenance/inject-fake-data', (req, res) => {
  devices = [
    { _id: 'dev-1', name: 'Living Room Lamp', type: 'light', room: 'Living Room', status: true, brightness: 70 },
    { _id: 'dev-2', name: 'Hallway Thermostat', type: 'thermostat', room: 'Hallway', status: true, temperature: 72 },
    { _id: 'dev-3', name: 'Front Door Lock', type: 'lock', room: 'Entry', status: true },
    { _id: 'dev-4', name: 'Bedroom Lamp', type: 'light', room: 'Bedroom', status: false, brightness: 0 },
  ];
  scenes = [
    { _id: 'scene-1', name: 'Movie Night', description: 'Dim lights, set temp to 70', devices: ['dev-1', 'dev-2'], active: false },
    { _id: 'scene-2', name: 'Good Morning', description: 'Turn on lights, set temp to 72', devices: ['dev-1', 'dev-4', 'dev-2'], active: false },
  ];
  voiceDevices = [
    { _id: 'voice-1', name: 'Kitchen Speaker', room: 'Kitchen', deviceType: 'speaker', status: 'online', lastSeen: new Date().toISOString(), powerSource: 'AC', connectionType: 'wifi', ipAddress: '192.168.1.20', volume: 60, microphoneSensitivity: 70, uptime: 3600 },
    { _id: 'voice-2', name: 'Bedroom Speaker', room: 'Bedroom', deviceType: 'speaker', status: 'offline', lastSeen: new Date(Date.now() - 3600_000).toISOString(), powerSource: 'AC', connectionType: 'wifi', volume: 40, microphoneSensitivity: 60, uptime: 0 },
  ];
  res.json({ success: true, results: { devices: devices.length, scenes: scenes.length, voiceDevices: voiceDevices.length } });
});

app.post('/api/maintenance/smartthings/sync', (req, res) => {
  smartthingsIntegration.deviceCount = 5;
  res.json({ success: true, deviceCount: smartthingsIntegration.deviceCount });
});

app.post('/api/maintenance/insteon/sync', (req, res) => {
  res.json({ success: true, message: 'INSTEON sync started (demo)' });
});

app.post('/api/maintenance/smartthings/clear-devices', (req, res) => {
  const deletedCount = smartthingsIntegration.deviceCount;
  smartthingsIntegration.deviceCount = 0;
  res.json({ success: true, deletedCount });
});

app.post('/api/maintenance/reset-settings', (req, res) => {
  appSettings.enableSecurityMode = false;
  res.json({ success: true });
});

app.post('/api/maintenance/smartthings/clear', (req, res) => {
  smartthingsIntegration = { isConfigured: false, isConnected: false, clientId: '', clientSecret: '', redirectUri: '', deviceCount: 0 };
  res.json({ success: true });
});

app.post('/api/maintenance/voice/clear', (req, res) => {
  const deletedCount = 12; // demo
  res.json({ success: true, deletedCount });
});

app.get('/api/maintenance/health', (req, res) => {
  const online = voiceDevices.filter(v => v.status === 'online').length;
  res.json({
    success: true,
    health: {
      database: {
        collections: {
          devices: devices.length,
          scenes: scenes.length,
          automations: 0,
          voiceDevices: voiceDevices.length,
          userProfiles: 0,
        }
      },
      devices: {
        total: devices.length,
        online: devices.filter(d => d.status).length,
        offline: devices.filter(d => !d.status).length,
      },
      voiceSystem: {
        online,
        devices: voiceDevices.length,
      },
      integrations: {
        smartthings: {
          connected: smartthingsIntegration.isConnected,
        }
      }
    }
  });
});

// --- Alias routes to match client API definitions ---
// Maintenance aliases
app.delete('/api/maintenance/fake-data', (req, res) => {
  const results = { devices: devices.length, scenes: scenes.length, automations: 0, voiceDevices: voiceDevices.length, userProfiles: 0, voiceCommands: 0, securityAlarms: 0 };
  devices = [];
  scenes = [];
  voiceDevices = [];
  res.json({ success: true, message: 'Fake data cleared', results });
});

app.post('/api/maintenance/fake-data', (req, res) => {
  devices = [
    { _id: 'dev-1', name: 'Living Room Lamp', type: 'light', room: 'Living Room', status: true, brightness: 70 },
    { _id: 'dev-2', name: 'Hallway Thermostat', type: 'thermostat', room: 'Hallway', status: true, temperature: 72 },
    { _id: 'dev-3', name: 'Front Door Lock', type: 'lock', room: 'Entry', status: true },
    { _id: 'dev-4', name: 'Bedroom Lamp', type: 'light', room: 'Bedroom', status: false, brightness: 0 },
  ];
  scenes = [
    { _id: 'scene-1', name: 'Movie Night', description: 'Dim lights, set temp to 70', devices: ['dev-1', 'dev-2'], active: false },
    { _id: 'scene-2', name: 'Good Morning', description: 'Turn on lights, set temp to 72', devices: ['dev-1', 'dev-4', 'dev-2'], active: false },
  ];
  voiceDevices = [
    { _id: 'voice-1', name: 'Kitchen Speaker', room: 'Kitchen', deviceType: 'speaker', status: 'online', lastSeen: new Date().toISOString(), powerSource: 'AC', connectionType: 'wifi', ipAddress: '192.168.1.20', volume: 60, microphoneSensitivity: 70, uptime: 3600 },
    { _id: 'voice-2', name: 'Bedroom Speaker', room: 'Bedroom', deviceType: 'speaker', status: 'offline', lastSeen: new Date(Date.now() - 3600_000).toISOString(), powerSource: 'AC', connectionType: 'wifi', volume: 40, microphoneSensitivity: 60, uptime: 0 },
  ];
  res.json({ success: true, message: 'Fake data injected', results: { devices: devices.length, scenes: scenes.length, automations: 0, voiceDevices: voiceDevices.length, userProfiles: 0 } });
});

app.post('/api/maintenance/sync/smartthings', (req, res) => {
  smartthingsIntegration.deviceCount = 5;
  res.json({ success: true, message: 'SmartThings sync started (demo)', deviceCount: smartthingsIntegration.deviceCount });
});

app.post('/api/maintenance/sync/insteon', (req, res) => {
  res.json({ success: true, message: 'INSTEON sync started (demo)' });
});

app.delete('/api/maintenance/devices/smartthings', (req, res) => {
  const deletedCount = smartthingsIntegration.deviceCount;
  smartthingsIntegration.deviceCount = 0;
  res.json({ success: true, message: 'SmartThings devices cleared', deletedCount });
});

app.delete('/api/maintenance/devices/insteon', (req, res) => {
  res.json({ success: true, message: 'INSTEON devices cleared', deletedCount: 0 });
});

app.post('/api/maintenance/reset/settings', (req, res) => {
  appSettings.enableSecurityMode = false;
  res.json({ success: true, message: 'Settings reset to defaults' });
});

app.delete('/api/maintenance/integrations/smartthings', (req, res) => {
  smartthingsIntegration = { isConfigured: false, isConnected: false, clientId: '', clientSecret: '', redirectUri: '', deviceCount: 0 };
  res.json({ success: true, message: 'SmartThings integration cleared' });
});

app.delete('/api/maintenance/voice-commands', (req, res) => {
  const deletedCount = 12; // demo
  res.json({ success: true, message: 'Voice commands cleared', deletedCount });
});

app.get('/api/maintenance/export', (req, res) => {
  const config = { appSettings, smartthingsIntegration, devices, scenes, voiceDevices };
  res.json({ success: true, message: 'Export generated', config });
});

// Settings test endpoints
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

