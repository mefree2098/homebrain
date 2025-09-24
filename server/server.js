const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const axios = require('axios');
const path = require('path');
const http = require('http');
const mongoose = require('mongoose');
const fs = require('fs');
const { randomUUID } = require('crypto');
require('dotenv').config();
const { Types: { ObjectId } } = mongoose;

const { connectDB, closeDB } = require('./config/database');
const { authMiddleware, isPublicRoute } = require('./middleware/auth');
const { hashPassword, comparePassword, validatePassword } = require('./utils/password');
const {
  issueAccessToken,
  issueRefreshToken,
  verifyRefreshToken,
  generateRefreshTokenValue,
} = require('./utils/tokens');
const { ROLES } = require('../shared/config/roles');

const SettingsModel = require('./models/Settings');
const DeviceModel = require('./models/Device');
const SceneModel = require('./models/Scene');
const AutomationModel = require('./models/Automation');
const VoiceDeviceModel = require('./models/VoiceDevice');
const VoiceCommandModel = require('./models/VoiceCommand');
const SecurityAlarmModel = require('./models/SecurityAlarm');
const SmartThingsIntegrationModel = require('./models/SmartThingsIntegration');
const UserProfileModel = require('./models/UserProfile');
const UserModel = require('./models/User');
const RemoteDeviceModel = require('./models/RemoteDevice');
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const deepClone = (value) => JSON.parse(JSON.stringify(value));

const generateId = (prefix = 'hb') => `${prefix}-${randomUUID()}`;

const isDbConnected = () => mongoose.connection && mongoose.connection.readyState === 1;

const ACCESS_CONTROL_ALLOWLIST = (process.env.CORS_ORIGIN || '').split(',').map((v) => v.trim()).filter(Boolean);

const DEMO_AUDIO_BUFFER = Buffer.from('ID3mock-homebrain-audio');

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
  if (isDbConnected()) {
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

  if (isDbConnected()) {
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
const prepareSeedData = () => {
  const base = createMemoryStore();
  return {
    devices: base.devices.map(({ _id, ...rest }) => rest),
    scenes: base.scenes.map(({ _id, devices, ...rest }) => ({
      ...rest,
      deviceActions: (devices || []).map((deviceId) => ({ deviceId, action: 'turn_on' })),
    })),
    automations: base.automations.map(({ _id, ...rest }) => rest),
    voiceDevices: base.voiceDevices.map(({ _id, ...rest }) => rest),
    profiles: base.voiceDevices.map((device, index) => ({
      name: index === 0 ? 'Matt' : 'Guest',
      wakeWords: index === 0 ? ['Anna', 'Henry'] : ['Home Brain'],
      voiceId: index === 0 ? 'voice_default_anna' : 'voice_default_ben',
      voiceName: index === 0 ? 'Anna' : 'Ben',
      systemPrompt: index === 0 ? 'You are Anna, a friendly smart home assistant who knows the household routine.' : 'Respond warmly and guide new users through voice options.',
      personality: index === 0 ? 'friendly' : 'helper',
      responseStyle: index === 0 ? 'concise' : 'detailed',
      preferredLanguage: 'en-US',
      timezone: 'America/New_York',
      speechRate: 1.0,
      speechPitch: 1.0,
      permissions: ['device_control', 'scene_control'],
      favorites: { devices: [], scenes: [] },
      contextMemory: true,
      learningMode: true,
      privacyMode: false,
    })),
    remoteDevices: base.remoteDevices.map(({ _id, ...rest }) => rest),
    voiceCommands: base.voiceCommandHistory.map(({ _id, command, status, timestamp }) => ({
      originalText: command,
      processedText: command,
      wakeWord: 'anna',
      sourceRoom: 'Living Room',
      deviceId: null,
      intent: { action: 'device_control', confidence: 0.6, entities: {} },
      execution: {
        status: status === 'success' ? 'success' : 'failed',
        startedAt: new Date(timestamp),
        completedAt: new Date(timestamp),
        executionTime: 0,
        actions: [],
      },
      response: { text: 'Acknowledged', responseTime: 250 },
    })),
  };
};

const demoSeedData = prepareSeedData();

async function seedCollection(Model, items) {
  if (!isDbConnected()) return;
  const count = await Model.estimatedDocumentCount().catch(() => 0);
  if (count > 0) return;
  if (!items || !items.length) return;
  await Model.insertMany(items);
}

async function seedDemoData() {
  if (!isDbConnected()) {
    console.warn('Skipping database seed because MongoDB is not connected.');
    return;
  }

  await seedCollection(DeviceModel, demoSeedData.devices);
  await seedCollection(SceneModel, demoSeedData.scenes);
  await seedCollection(AutomationModel, demoSeedData.automations);
  await seedCollection(VoiceDeviceModel, demoSeedData.voiceDevices);
  await seedCollection(UserProfileModel, demoSeedData.profiles);
  await seedCollection(RemoteDeviceModel, demoSeedData.remoteDevices);
  await seedCollection(VoiceCommandModel, demoSeedData.voiceCommands);

  const existingAlarm = await SecurityAlarmModel.estimatedDocumentCount().catch(() => 0);
  if (!existingAlarm) {
    await SecurityAlarmModel.create({
      name: 'Home Security System',
      alarmState: 'disarmed',
      zones: [
        { name: 'Front Door', deviceId: 'dev-3', deviceType: 'doorWindow', enabled: true, bypassable: true },
        { name: 'Hallway Motion', deviceId: 'st-device-3', deviceType: 'motion', enabled: true, bypassable: true },
      ],
      disarmedBy: 'Demo User',
      isOnline: true,
    });
  }

  const integrationCount = await SmartThingsIntegrationModel.estimatedDocumentCount().catch(() => 0);
  if (!integrationCount) {
    await SmartThingsIntegrationModel.create({
      clientId: process.env.SMARTTHINGS_CLIENT_ID || '',
      clientSecret: process.env.SMARTTHINGS_CLIENT_SECRET || '',
      redirectUri: process.env.SMARTTHINGS_REDIRECT_URI || 'http://localhost:3000/api/smartthings/callback',
      isConfigured: false,
      isConnected: false,
      connectedDevices: [],
    });
  }
}
async function getSmartThingsAccessToken() {
  const settingsToken = appSettings.smartthingsToken && appSettings.smartthingsToken.trim();
  if (settingsToken) return settingsToken;

  if (isDbConnected()) {
    try {
      const integration = await SmartThingsIntegrationModel.getIntegration();
      if (integration && integration.accessToken) {
        return integration.accessToken;
      }
    } catch (error) {
      console.warn('Failed to load SmartThings integration from DB:', error.message);
    }
  }

  return null;
}

async function smartThingsRequest(method, endpoint, { params, data } = {}) {
  const token = await getSmartThingsAccessToken();
  if (!token) {
    const error = new Error('SmartThings integration is not configured');
    error.status = 400;
    throw error;
  }

  const url = `https://api.smartthings.com/v1${endpoint}`;
  return axios({
    method,
    url,
    params,
    data,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 10_000,
  });
}

function sendMockAudio(res) {
  res.set('Content-Type', 'audio/mpeg');
  res.send(Buffer.from(DEMO_AUDIO_BUFFER));
}

async function elevenLabsRequest(method, endpoint, options = {}) {
  const apiKey = appSettings.elevenlabsApiKey && appSettings.elevenlabsApiKey.trim();
  if (!apiKey) {
    const error = new Error('ElevenLabs API key is not configured');
    error.status = 503;
    throw error;
  }

  const baseURL = 'https://api.elevenlabs.io/v1';
  return axios({
    baseURL,
    method,
    url: endpoint,
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': options.responseType === 'arraybuffer' ? 'application/json' : 'application/json',
      ...(options.headers || {}),
    },
    timeout: 15_000,
    ...options,
  });
}
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
app.use(rateLimit({ windowMs: 60 * 1000, max: Number(process.env.RATE_LIMIT_MAX || 120) }));
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
const sanitizeUser = (user) => {
  if (!user) return null;
  const obj = user.toObject ? user.toObject() : { ...user };
  delete obj.password;
  delete obj.refreshToken;
  delete obj.__v;
  return obj;
};

async function buildAuthResponse(user) {
  const tokenId = generateRefreshTokenValue();
  user.refreshToken = tokenId;
  user.lastLoginAt = new Date();
  await user.save();

  const payload = { sub: user._id.toString(), email: user.email, role: user.role };
  const accessToken = issueAccessToken(payload);
  const refreshToken = issueRefreshToken({ ...payload, tokenId });

  return {
    accessToken,
    refreshToken,
    user: sanitizeUser(user),
  };
}

async function authenticateCredentials(email, password) {
  const user = await UserModel.findOne({ email: email.toLowerCase() });
  if (!user) {
    return null;
  }

  const passwordMatches = await comparePassword(password, user.password);
  if (!passwordMatches) {
    return null;
  }

  if (!user.isActive) {
    const error = new Error('Account is disabled');
    error.status = 403;
    throw error;
  }

  return user;
}
app.get('/api/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/auth/register', asyncHandler(async (req, res) => {
  const { email, password, role } = req.body || {};
  if (!email || !password) {
    return sendError(res, 400, 'Email and password are required');
  }

  if (!validatePassword(password)) {
    return sendError(res, 400, 'Password must be at least 8 characters and include letters and numbers');
  }

  const existingUser = await UserModel.findOne({ email: email.toLowerCase() });
  if (existingUser) {
    return sendError(res, 409, 'An account with this email already exists');
  }

  const hashedPassword = await hashPassword(password);
  const isFirstUser = (await UserModel.estimatedDocumentCount().catch(() => 0)) === 0;
  const userRole = isFirstUser ? ROLES.ADMIN : (role && Object.values(ROLES).includes(role) ? role : ROLES.USER);

  const user = await UserModel.create({
    email: email.toLowerCase(),
    password: hashedPassword,
    role: userRole,
  });

  const authPayload = await buildAuthResponse(user);
  return sendSuccess(res, authPayload, 201);
}));

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return sendError(res, 400, 'Email and password are required');
  }

  const user = await authenticateCredentials(email, password);
  if (!user) {
    return sendError(res, 401, 'Invalid email or password');
  }

  const authPayload = await buildAuthResponse(user);
  return sendSuccess(res, authPayload);
}));

app.post('/api/auth/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return sendError(res, 400, 'refreshToken is required');
  }

  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (error) {
    return sendError(res, 401, 'Invalid or expired refresh token');
  }

  const user = await UserModel.findById(decoded.sub);
  if (!user || user.refreshToken !== decoded.tokenId) {
    return sendError(res, 401, 'Refresh token is no longer valid');
  }

  const authPayload = await buildAuthResponse(user);
  return sendSuccess(res, authPayload);
}));
app.use(authMiddleware);
app.post('/api/auth/logout', asyncHandler(async (req, res) => {
  if (!req.user) {
    return sendError(res, 401, 'Not authenticated');
  }

  await UserModel.findByIdAndUpdate(req.user.id, { refreshToken: generateRefreshTokenValue() }).catch(() => null);
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

  try {
    const response = await elevenLabsRequest('get', '/voices', { params: { page_size: 1 } });
    return sendSuccess(res, { success: true, message: 'ElevenLabs key OK', voiceCount: response.data?.voices?.length || 0 });
  } catch (error) {
    return sendError(res, error.response?.status || 500, error.response?.data?.message || 'Failed to reach ElevenLabs');
  }
}));

app.post('/api/settings/test-openai', asyncHandler(async (req, res) => {
  const { apiKey, model } = req.body || {};
  const key = apiKey || appSettings.openaiApiKey;
  if (!key) {
    return sendError(res, 400, 'apiKey required');
  }

  try {
    const response = await axios({
      method: 'post',
      url: 'https://api.openai.com/v1/chat/completions',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      data: {
        model: model || appSettings.openaiModel || 'gpt-3.5-turbo',
        messages: [{ role: 'system', content: 'You are HomeBrain.' }, { role: 'user', content: 'Ping' }],
        max_tokens: 5,
      },
      timeout: 10_000,
    });
    return sendSuccess(res, { success: true, message: 'OpenAI key OK', model: response.data?.model });
  } catch (error) {
    const status = error.response?.status || 500;
    return sendError(res, status, error.response?.data?.error?.message || 'Failed to reach OpenAI');
  }
}));

app.post('/api/settings/test-anthropic', asyncHandler(async (req, res) => {
  const { apiKey, model } = req.body || {};
  const key = apiKey || appSettings.anthropicApiKey;
  if (!key) {
    return sendError(res, 400, 'apiKey required');
  }

  try {
    const response = await axios({
      method: 'post',
      url: 'https://api.anthropic.com/v1/messages',
      headers: {
        'x-api-key': key,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
      },
      data: {
        model: model || appSettings.anthropicModel || 'claude-3-sonnet-20240229',
        max_tokens: 5,
        messages: [{ role: 'user', content: 'Ping' }],
      },
      timeout: 10_000,
    });
    return sendSuccess(res, { success: true, message: 'Anthropic key OK', model: response.data?.model });
  } catch (error) {
    const status = error.response?.status || 500;
    return sendError(res, status, error.response?.data?.error?.message || 'Failed to reach Anthropic');
  }
}));

app.post('/api/settings/test-local-llm', asyncHandler(async (req, res) => {
  const { endpoint, model } = req.body || {};
  const url = endpoint || appSettings.localLlmEndpoint;
  if (!url) {
    return sendError(res, 400, 'endpoint required');
  }

  try {
    const response = await axios({
      method: 'post',
      url,
      data: { prompt: 'ping', model: model || appSettings.localLlmModel },
      timeout: 5_000,
    });
    return sendSuccess(res, { success: true, message: 'Local LLM reachable', endpoint: url, model: model || appSettings.localLlmModel, info: response.data });
  } catch (error) {
    return sendError(res, error.response?.status || 500, error.message || 'Failed to reach local LLM endpoint');
  }
}));

app.post('/api/settings/test-smartthings', asyncHandler(async (req, res) => {
  try {
    const response = await smartThingsRequest('get', '/devices', { params: { max: 1 } });
    return sendSuccess(res, { success: true, message: 'SmartThings connection OK', deviceCount: response.data?.items?.length || 0 });
  } catch (error) {
    const status = error.status || error.response?.status || 500;
    return sendError(res, status, error.response?.data?.message || error.message || 'Failed to reach SmartThings');
  }
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

