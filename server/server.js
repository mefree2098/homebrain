const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const http = require('http');
require('dotenv').config();

const { connectDB } = require('./config/database');

// Create Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

// Connect to DB (but don't crash the whole process if missing during first run)
connectDB();

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

// Start HTTP server
const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
server.listen(PORT, () => {
  console.log(`HomeBrain API listening on port ${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
