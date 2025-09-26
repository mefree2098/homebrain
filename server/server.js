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
const fsPromises = fs.promises;
const https = require('https');
const tls = require('tls');
const crypto = require('crypto');
const { randomUUID, X509Certificate } = crypto;
require('dotenv').config();

const { createInsteonClient, normalizeBaseUrl } = require('./utils/insteonClient');
const WebSocket = require('ws');

const {
  initializeUserStore,
  verifyUserCredentials,
  findUserByRefreshToken,
  rotateRefreshToken,
  sanitizeUser,
  updateUser,
  DEFAULT_ADMIN_EMAIL,
  DEFAULT_PASSWORD_FROM_ENV,
  revokeRefreshToken,
} = require('./services/userStore');

const SettingsModel = require('./models/Settings');
let SecurityAlarmModel = null;
let UserProfileModel = null;

try {
  SecurityAlarmModel = require('./models/SecurityAlarm');
} catch (error) {
  SecurityAlarmModel = null;
}

try {
  UserProfileModel = require('./models/UserProfile');
} catch (error) {
  UserProfileModel = null;
}
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
  insteon: {
    enabled: false,
    bridgeStatus: null,
    devices: [],
    lastSync: null,
    lastSyncSummary: null,
    lastError: null,
    mock: false,
  },
  userProfiles: [],
  elevenLabs: { voices: [], lastFetched: 0 },
});

let memoryStore = createMemoryStore();

let currentServerTransport = 'http';
let httpServerInstance = null;
let httpsServerInstance = null;

const SSL_PLACEHOLDER = '\u0007'.repeat(32);
const SSL_SENSITIVE_KEYS = new Set(['sslPrivateKey', 'sslCertificate', 'sslCertificateChain']);

const ELEVENLABS_BASE_URL = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io';
const ELEVENLABS_TIMEOUT_MS = Number(process.env.ELEVENLABS_TIMEOUT_MS || 15000);
const ELEVENLABS_CACHE_TTL_MS = Number(process.env.ELEVENLABS_CACHE_TTL_MS || 5 * 60 * 1000);
const LOGS_DIR = path.join(__dirname, 'logs');
const CLIENT_LOG_FILE = path.join(LOGS_DIR, 'client-logs.ndjson');

const DEFAULT_INSTEON_BRIDGE_URL = 'http://127.0.0.1:8765';

const ensureLogsDir = () => {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
};

const DEFAULT_SETTINGS = {
  location: 'New York, NY',
  timezone: 'America/New_York',
  wakeWordSensitivity: 0.7,
  voiceVolume: 0.8,
  microphoneSensitivity: 0.6,
  enableVoiceConfirmation: true,
  enableNotifications: true,
  insteonPort: '/dev/ttyUSB0',
  insteonEnabled: false,
  insteonBridgeUrl: 'http://127.0.0.1:8765',
  insteonPollInterval: 15000,
  insteonAuthToken: '',
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
  sslEnabled: false,
  sslForceHttps: false,
  sslPrivateKey: '',
  sslCertificate: '',
  sslCertificateChain: '',
  sslLastAppliedAt: null,
  sslLastError: null,
};

let appSettings = { ...DEFAULT_SETTINGS };
let settingsLoaded = false;
let settingsLoadPromise = null;

const isMaskedPlaceholderValue = (value) => {
  if (typeof value !== 'string') {
    return false;
  }
  if (!value.includes('*')) {
    return false;
  }
  const unmaskedLength = value.replace(/\*/g, '').length;
  return unmaskedLength <= 4;
};

const dataDir = path.join(__dirname, 'data');
const settingsFilePath = path.join(dataDir, 'settings.json');
const profilesFilePath = path.join(dataDir, 'user-profiles.json');
const insteonDevicesFilePath = path.join(dataDir, 'insteon-devices.json');

const ensureDataDir = () => {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
};

const readUserProfilesFromDisk = () => {
  try {
    if (fs.existsSync(profilesFilePath)) {
      const raw = fs.readFileSync(profilesFilePath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    }
  } catch (error) {
    console.warn('Failed to read user profiles from disk:', error.message);
  }
  return null;
};

const writeUserProfilesToDisk = (profiles) => {
  try {
    ensureDataDir();
    fs.writeFileSync(profilesFilePath, JSON.stringify(profiles, null, 2), 'utf-8');
  } catch (error) {
    console.warn('Failed to write user profiles to disk:', error.message);
  }
};

const loadUserProfilesFromDisk = ({ log = true } = {}) => {
  const persisted = readUserProfilesFromDisk();
  if (Array.isArray(persisted)) {
    memoryStore.userProfiles = persisted;
    if (log) {
      console.log(`Loaded ${persisted.length} user profile(s) from disk cache.`);
    }
  } else {
    memoryStore.userProfiles = [];
    if (log) {
      console.log('No persisted user profiles found on disk; starting fresh.');
    }
  }
};

const readInsteonDevicesFromDisk = () => {
  try {
    if (fs.existsSync(insteonDevicesFilePath)) {
      const raw = fs.readFileSync(insteonDevicesFilePath, 'utf-8');
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { devices: parsed, lastSync: null, lastSyncSummary: null };
      }
      if (parsed && typeof parsed === 'object') {
        return {
          devices: Array.isArray(parsed.devices) ? parsed.devices : [],
          lastSync: parsed.lastSync || null,
          lastSyncSummary: parsed.lastSyncSummary || null,
          mockMode: typeof parsed.mockMode === 'boolean' ? parsed.mockMode : undefined,
        };
      }
    }
  } catch (error) {
    console.warn('Failed to read Insteon devices from disk:', error.message);
  }
  return null;
};

const writeInsteonDevicesToDisk = (snapshot) => {
  try {
    ensureDataDir();
    fs.writeFileSync(insteonDevicesFilePath, JSON.stringify(snapshot, null, 2), 'utf-8');
  } catch (error) {
    console.warn('Failed to write Insteon devices to disk:', error.message);
  }
};

const applyInsteonDeviceSnapshot = (devices, { lastSync = null, summary = null, persist = true } = {}) => {
  const normalized = Array.isArray(devices) ? devices.map((device) => deepClone(device)) : [];
  memoryStore.insteon.devices = normalized;
  memoryStore.insteon.lastSync = lastSync;
  memoryStore.insteon.lastSyncSummary = summary;
  if (summary && typeof summary === 'object') {
    if (typeof summary.mockMode === 'boolean') {
      memoryStore.insteon.mock = summary.mockMode;
    } else if (summary.mode) {
      memoryStore.insteon.mock = summary.mode === 'mock';
    }
  }
  if (persist) {
    writeInsteonDevicesToDisk({ devices: normalized, lastSync, lastSyncSummary: summary, mockMode: memoryStore.insteon.mock });
  }
};

const loadInsteonDevicesFromDisk = ({ log = true } = {}) => {
  const persisted = readInsteonDevicesFromDisk();
  if (persisted) {
    applyInsteonDeviceSnapshot(persisted.devices || [], { lastSync: persisted.lastSync || null, summary: persisted.lastSyncSummary || null, persist: false });
    if (typeof persisted.mockMode === 'boolean') {
      memoryStore.insteon.mock = persisted.mockMode;
    }
    if (log) {
      console.log(`Loaded ${memoryStore.insteon.devices.length} Insteon device(s) from disk cache.`);
    }
  } else if (log) {
    console.log('No persisted Insteon devices found on disk; starting fresh.');
  }
};

loadUserProfilesFromDisk();
loadInsteonDevicesFromDisk();

const INSTEON_HTTP_TIMEOUT_MS = Number(process.env.INSTEON_HTTP_TIMEOUT_MS || 8000);
const INSTEON_MIN_POLL_INTERVAL_MS = 1000;
let cachedInsteonClient = null;

function ensureInsteonEnabledFlag() {
  memoryStore.insteon.enabled = !!(appSettings && appSettings.insteonEnabled);
}

function resolveInsteonBaseUrl() {
  const candidate = (appSettings && appSettings.insteonBridgeUrl)
    || process.env.INSTEON_BRIDGE_URL
    || DEFAULT_INSTEON_BRIDGE_URL;
  return normalizeBaseUrl(candidate);
}

function resolveInsteonAuthToken() {
  const token = (appSettings && appSettings.insteonAuthToken) || process.env.INSTEON_AUTH_TOKEN || '';
  const trimmed = String(token).trim();
  return trimmed ? trimmed : null;
}

function getInsteonClient({ allowDisabled = false } = {}) {
  if (!allowDisabled && !(appSettings && appSettings.insteonEnabled)) {
    const error = new Error('Insteon integration is disabled');
    error.status = 409;
    throw error;
  }
  if (!cachedInsteonClient) {
    cachedInsteonClient = createInsteonClient({
      baseUrl: resolveInsteonBaseUrl(),
      authToken: resolveInsteonAuthToken(),
      timeoutMs: INSTEON_HTTP_TIMEOUT_MS,
    });
  }
  return cachedInsteonClient;
}

function invalidateInsteonClient() {
  cachedInsteonClient = null;
}

function getResolvedInsteonPollInterval() {
  const value = Number(appSettings && appSettings.insteonPollInterval);
  if (Number.isFinite(value) && value >= INSTEON_MIN_POLL_INTERVAL_MS) {
    return value;
  }
  return DEFAULT_SETTINGS.insteonPollInterval;
}

function recordInsteonBridgeStatus(status) {
  if (!status || typeof status !== 'object') {
    memoryStore.insteon.bridgeStatus = null;
    memoryStore.insteon.mock = false;
    return null;
  }
  const snapshot = { ...status, fetchedAt: new Date().toISOString() };
  memoryStore.insteon.bridgeStatus = snapshot;
  memoryStore.insteon.mock = Boolean(snapshot.mock_mode || snapshot.mode === 'mock');
  return snapshot;
}

function recordInsteonError(error) {
  const entry = {
    message: error && error.message ? error.message : 'Unknown Insteon bridge error',
    at: new Date().toISOString(),
  };
  if (error && error.status) {
    entry.status = error.status;
  }
  if (error && error.details) {
    entry.details = error.details;
  }
  memoryStore.insteon.lastError = entry;
  return entry;
}

async function fetchInsteonBridgeStatus({ allowDisabled = false } = {}) {
  const client = getInsteonClient({ allowDisabled });
  const response = await client.status();
  const snapshot = response && response.status ? response.status : response;
  recordInsteonBridgeStatus(snapshot);
  memoryStore.insteon.lastError = null;
  return snapshot;
}

async function syncInsteonDevices({ refresh = true, includeDevices = false } = {}) {
  const client = getInsteonClient();
  const result = await client.discovery({ refresh });
  const devices = Array.isArray(result && result.devices) ? result.devices : [];
  const lastSync = new Date().toISOString();
  const summary = { mode: result && result.mode ? result.mode : 'unknown', count: devices.length };
  applyInsteonDeviceSnapshot(devices, { lastSync, summary });
  memoryStore.insteon.lastError = null;
  return {
    ...summary,
    lastSync,
    devices: includeDevices ? devices : undefined,
    raw: result,
  };
}

const INSTEON_WS_MIN_BACKOFF_MS = 2000;
const INSTEON_WS_MAX_BACKOFF_MS = 60000;
let insteonPollEnabled = false;
let insteonPollTimer = null;
let insteonPollInFlight = false;
let insteonWs = null;
let insteonWsReconnectTimer = null;
let insteonWsBackoffMs = INSTEON_WS_MIN_BACKOFF_MS;

function normalizeDeviceId(value) {
  return String(value || '').replace(/[^a-f0-9]/gi, '').toLowerCase();
}

function persistInsteonDevices() {
  writeInsteonDevicesToDisk({
    devices: memoryStore.insteon.devices,
    lastSync: memoryStore.insteon.lastSync,
    lastSyncSummary: memoryStore.insteon.lastSyncSummary,
  });
}

function mergeInsteonDeviceSnapshot(device, { persist = false } = {}) {
  if (!device || typeof device !== 'object') {
    return;
  }
  const normalized = normalizeDeviceId(device.id || device.address);
  if (!normalized) {
    return;
  }
  const snapshot = deepClone(device);
  snapshot.id = normalized;
  const devices = memoryStore.insteon.devices;
  const index = devices.findIndex((item) => normalizeDeviceId(item.id || item.address) === normalized);
  if (index >= 0) {
    devices[index] = { ...devices[index], ...snapshot };
  } else {
    devices.push(snapshot);
  }
  if (persist) {
    memoryStore.insteon.lastSync = new Date().toISOString();
    persistInsteonDevices();
  }
}

function removeInsteonDeviceById(deviceId, { persist = false } = {}) {
  const normalized = normalizeDeviceId(deviceId);
  if (!normalized) {
    return;
  }
  const beforeLength = memoryStore.insteon.devices.length;
  memoryStore.insteon.devices = memoryStore.insteon.devices.filter((item) => normalizeDeviceId(item.id || item.address) !== normalized);
  if (persist && memoryStore.insteon.devices.length !== beforeLength) {
    memoryStore.insteon.lastSync = new Date().toISOString();
    persistInsteonDevices();
  }
}

function clearInsteonPollTimer() {
  if (insteonPollTimer) {
    clearTimeout(insteonPollTimer);
    insteonPollTimer = null;
  }
}

function scheduleInsteonPoll(delayMs) {
  clearInsteonPollTimer();
  insteonPollTimer = setTimeout(() => {
    insteonPollTimer = null;
    runInsteonPoll().catch((error) => {
      console.warn('Insteon poll failed:', error?.message || error);
    });
  }, Math.max(delayMs, INSTEON_MIN_POLL_INTERVAL_MS));
}

async function runInsteonPoll() {
  if (!insteonPollEnabled || insteonPollInFlight) {
    return;
  }
  insteonPollInFlight = true;
  try {
    await ensureSettingsLoaded();
    if (!appSettings.insteonEnabled) {
      return;
    }
    await fetchInsteonBridgeStatus({ allowDisabled: true });

    const pollInterval = getResolvedInsteonPollInterval();
    const lastSyncIso = memoryStore.insteon.lastSync;
    const lastSyncMs = lastSyncIso ? Date.parse(lastSyncIso) : 0;
    const staleThreshold = Math.max(pollInterval * 2, 60_000);
    const needsSync = !memoryStore.insteon.devices.length || !lastSyncMs || (Date.now() - lastSyncMs) > staleThreshold;

    if (needsSync) {
      try {
        await syncInsteonDevices({ refresh: false, includeDevices: false });
      } catch (syncError) {
        recordInsteonError(syncError);
      }
    }
  } catch (error) {
    recordInsteonError(error);
  } finally {
    insteonPollInFlight = false;
    if (insteonPollEnabled) {
      scheduleInsteonPoll(getResolvedInsteonPollInterval());
    }
  }
}

function stopInsteonPoller() {
  insteonPollEnabled = false;
  clearInsteonPollTimer();
}

function startInsteonPoller({ immediate = true } = {}) {
  stopInsteonPoller();
  insteonPollEnabled = true;
  if (immediate) {
    runInsteonPoll().catch((error) => {
      console.warn('Initial Insteon poll failed:', error?.message || error);
    });
  } else {
    scheduleInsteonPoll(getResolvedInsteonPollInterval());
  }
}

function clearInsteonWsReconnect() {
  if (insteonWsReconnectTimer) {
    clearTimeout(insteonWsReconnectTimer);
    insteonWsReconnectTimer = null;
  }
}

function scheduleInsteonWsReconnect() {
  if (!appSettings?.insteonEnabled || insteonWsReconnectTimer) {
    return;
  }
  const delay = insteonWsBackoffMs;
  insteonWsBackoffMs = Math.min(INSTEON_WS_MAX_BACKOFF_MS, Math.max(INSTEON_WS_MIN_BACKOFF_MS, insteonWsBackoffMs * 2));
  insteonWsReconnectTimer = setTimeout(() => {
    insteonWsReconnectTimer = null;
    connectInsteonWebSocket();
  }, delay);
}

function closeInsteonWebSocket({ scheduleReconnect = false } = {}) {
  clearInsteonWsReconnect();
  if (insteonWs) {
    try {
      insteonWs.removeAllListeners();
      insteonWs.close();
    } catch (error) {
      console.warn('Error closing Insteon WebSocket:', error.message);
    }
    insteonWs = null;
  }
  if (scheduleReconnect) {
    scheduleInsteonWsReconnect();
  } else {
    insteonWsBackoffMs = INSTEON_WS_MIN_BACKOFF_MS;
  }
}

function handleInsteonEvent(event) {
  if (!event || typeof event !== 'object') {
    return;
  }

  if (typeof event.mock_mode === 'boolean') {
    memoryStore.insteon.mock = event.mock_mode;
  } else if (event.mode === 'mock') {
    memoryStore.insteon.mock = true;
  }

  switch (event.type) {
    case 'bridge_status':
      recordInsteonBridgeStatus(event);
      memoryStore.insteon.lastError = null;
      break;
    case 'device_snapshot':
    case 'discovery_complete': {
      if (Array.isArray(event.devices)) {
        const summary = {
          source: 'ws',
          mode: event.mode || 'ws',
          count: event.devices.length,
          mockMode: event.mode === 'mock',
        };
        applyInsteonDeviceSnapshot(event.devices, { lastSync: new Date().toISOString(), summary, persist: true });
        memoryStore.insteon.lastError = null;
      }
      break;
    }
    case 'device_added':
      if (event.device) {
        mergeInsteonDeviceSnapshot(event.device, { persist: true });
        memoryStore.insteon.lastError = null;
      }
      break;
    case 'device_removed':
      if (event.device_id) {
        removeInsteonDeviceById(event.device_id, { persist: true });
        memoryStore.insteon.lastError = null;
      }
      break;
    case 'device_event':
    case 'device_state':
      if (event.device) {
        mergeInsteonDeviceSnapshot(event.device, { persist: false });
        memoryStore.insteon.lastError = null;
      }
      break;
    case 'command_ack':
      memoryStore.insteon.lastError = null;
      break;
    default:
      break;
  }
}

function connectInsteonWebSocket() {
  if (!appSettings?.insteonEnabled) {
    return;
  }
  closeInsteonWebSocket({ scheduleReconnect: false });

  let wsUrl;
  try {
    const baseUrl = resolveInsteonBaseUrl();
    const url = new URL(baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`;
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl = url.toString();
  } catch (error) {
    console.warn('Invalid Insteon bridge URL for WebSocket connection:', error.message);
    return;
  }

  const headers = {};
  const token = resolveInsteonAuthToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  insteonWs = new WebSocket(wsUrl, { headers });
  insteonWsBackoffMs = INSTEON_WS_MIN_BACKOFF_MS;

  insteonWs.on('open', () => {
    console.log('Connected to Insteon bridge WebSocket.');
    memoryStore.insteon.lastError = null;
  });

  insteonWs.on('message', (data) => {
    try {
      const payload = typeof data === 'string' ? data : data.toString('utf-8');
      if (!payload) {
        return;
      }
      const event = JSON.parse(payload);
      handleInsteonEvent(event);
    } catch (error) {
      console.warn('Failed to process Insteon WebSocket payload:', error.message);
    }
  });

  insteonWs.on('close', (code) => {
    console.warn(`Insteon bridge WebSocket closed (code ${code}).`);
    insteonWs = null;
    if (appSettings?.insteonEnabled) {
      scheduleInsteonWsReconnect();
    }
  });

  insteonWs.on('error', (error) => {
    console.warn('Insteon bridge WebSocket error:', error.message);
  });
}

async function stopInsteonRuntime() {
  stopInsteonPoller();
  closeInsteonWebSocket({ scheduleReconnect: false });
  memoryStore.insteon.mock = false;
}

async function refreshInsteonRuntime({ reason } = {}) {
  await ensureSettingsLoaded();
  ensureInsteonEnabledFlag();
  invalidateInsteonClient();

  if (!appSettings.insteonEnabled) {
    await stopInsteonRuntime();
    memoryStore.insteon.bridgeStatus = null;
    return false;
  }

  startInsteonPoller({ immediate: true });
  connectInsteonWebSocket();
  return true;
}

function getInsteonDeviceById(deviceId) {
  if (!deviceId) {
    return null;
  }
  const target = String(deviceId).toLowerCase();
  return memoryStore.insteon.devices.find((device) => {
    const id = String(device.id || device.address || device._id || '').toLowerCase();
    return id === target;
  }) || null;
}

ensureInsteonEnabledFlag();

const getMemoryStoreCounts = () => ({
  devices: memoryStore.devices.length,
  scenes: memoryStore.scenes.length,
  automations: memoryStore.automations.length,
  voiceDevices: memoryStore.voiceDevices.length,
  userProfiles: memoryStore.userProfiles.length,
  voiceCommands: memoryStore.voiceCommandHistory.length,
  securityAlarms: memoryStore.security?.alarm ? 1 : 0,
  smartthingsDevices: memoryStore.smartthings?.devices?.length || 0,
  smartthingsScenes: memoryStore.smartthings?.scenes?.length || 0,
  insteonDevices: memoryStore.insteon?.devices?.length || 0,
});

const resetMemoryStore = ({ includeSamples = true, loadProfiles = true } = {}) => {
  let newStore = createMemoryStore();

  if (!includeSamples) {
    newStore.devices = [];
    newStore.scenes = [];
    newStore.automations = [];
    newStore.voiceDevices = [];
    newStore.voiceCommandHistory = [];
    newStore.remoteDevices = [];
    newStore.discovery = { enabled: false, lastScan: null, autoApproveRooms: [], pendingDevices: [] };
    newStore.smartthings = { devices: [], scenes: [] };
    newStore.security = {
      status: {
        alarmState: 'disarmed',
        isArmed: false,
        isTriggered: false,
        isOnline: false,
        zoneCount: 0,
        activeZones: 0,
        bypassedZones: 0,
        lastArmed: null,
        lastDisarmed: null,
        armedBy: null,
        lastTriggered: null,
      },
      alarm: null,
    };
  }

  memoryStore = newStore;
  loadInsteonDevicesFromDisk({ log: false });
  if (loadProfiles) {
    loadUserProfilesFromDisk({ log: false });
  } else {
    memoryStore.userProfiles = [];
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
  normalizeSslFields(next);

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

async function ensureSettingsLoaded() {
  if (settingsLoaded) {
    return appSettings;
  }

  if (settingsLoadPromise) {
    return settingsLoadPromise;
  }

  settingsLoadPromise = (async () => {
    const persisted = await readSettingsPersisted();
    appSettings = { ...DEFAULT_SETTINGS, ...persisted };
    normalizeSslFields(appSettings);
    ensureInsteonEnabledFlag();
    invalidateInsteonClient();
    settingsLoaded = true;
    return appSettings;
  })();

  try {
    return await settingsLoadPromise;
  } finally {
    settingsLoadPromise = null;
  }
}

const PEM_HEADER_PATTERN = /^-----BEGIN [A-Z0-9 ]+-----/m;
const CERTIFICATE_HEADER_PATTERN = /-----BEGIN CERTIFICATE-----/;

const normalizePem = (input) => {
  if (typeof input !== 'string') {
    return '';
  }
  const trimmed = input.trim();
  if (!trimmed) {
    return '';
  }
  if (!PEM_HEADER_PATTERN.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed.replace(/\r\n/g, '\n')}\n`;
};

const splitCertificateChain = (pemString) => {
  const normalized = normalizePem(pemString);
  if (!normalized || !CERTIFICATE_HEADER_PATTERN.test(normalized)) {
    return [];
  }
  return normalized
    .split(/(?=-----BEGIN CERTIFICATE-----)/g)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => (block.endsWith('\n') ? block : `${block}\n`));
};

const normalizeSslFields = (settings) => {
  if (!settings || typeof settings !== 'object') {
    return;
  }
  ['sslPrivateKey', 'sslCertificate', 'sslCertificateChain'].forEach((key) => {
    if (typeof settings[key] === 'string' && settings[key]) {
      settings[key] = normalizePem(settings[key]);
    }
  });
};

const buildSslCredentials = (settings) => {
  if (!settings || typeof settings !== 'object') {
    throw new Error('SSL settings are missing');
  }
  const key = normalizePem(settings.sslPrivateKey || '');
  const cert = normalizePem(settings.sslCertificate || '');

  if (!key || !key.includes('-----BEGIN')) {
    const error = new Error('SSL private key is missing or not in PEM format');
    error.status = 400;
    throw error;
  }
  if (!cert || !cert.includes('-----BEGIN CERTIFICATE-----')) {
    const error = new Error('SSL certificate is missing or not in PEM format');
    error.status = 400;
    throw error;
  }

  const credentials = { key, cert };
  const chainParts = splitCertificateChain(settings.sslCertificateChain || '');
  if (chainParts.length === 1) {
    credentials.ca = chainParts[0];
  } else if (chainParts.length > 1) {
    credentials.ca = chainParts;
  }

  return credentials;
};

const SENSITIVE_MASK_KEYS = [
  'elevenlabsApiKey',
  'smartthingsToken',
  'smartthingsClientSecret',
  'openaiApiKey',
  'anthropicApiKey',
  'insteonAuthToken',
];

const buildSslStatus = (settings) => {
  const status = {
    enabled: !!settings.sslEnabled,
    forceHttps: !!settings.sslForceHttps,
    configured: !!(settings.sslPrivateKey && settings.sslCertificate),
    httpsActive: currentServerTransport === 'https',
    lastAppliedAt: settings.sslLastAppliedAt || null,
    lastError: settings.sslLastError || null,
  };

  if (status.configured && typeof settings.sslCertificate === 'string' && settings.sslCertificate.includes('BEGIN CERTIFICATE') && X509Certificate) {
    try {
      const certificate = new X509Certificate(normalizePem(settings.sslCertificate));
      status.subject = certificate.subject;
      status.issuer = certificate.issuer;
      status.validFrom = certificate.validFrom;
      status.validTo = certificate.validTo;
      if (certificate.subjectAltName) {
        status.altNames = certificate.subjectAltName.split(',').map((entry) => entry.trim());
      }
      status.fingerprint256 = certificate.fingerprint256;
    } catch (error) {
      status.parseError = error.message;
    }
  }

  return status;
};

const maskSensitiveSettings = (settings) => {
  const masked = { ...settings };

  SENSITIVE_MASK_KEYS.forEach((key) => {
    if (typeof masked[key] === 'string' && masked[key]) {
      masked[key] = masked[key].replace(/.(?=.{4})/g, '*');
    }
  });

  SSL_SENSITIVE_KEYS.forEach((key) => {
    if (masked[key]) {
      masked[key] = SSL_PLACEHOLDER;
    }
  });

  masked.sslStatus = buildSslStatus(settings);

  return masked;
};
const buildMockSmartThingsSummary = () => ({
  connected: memoryStore.smartthings?.isConnected ?? true,
  devices: deepClone(memoryStore.smartthings?.devices || []),
  scenes: deepClone(memoryStore.smartthings?.scenes || []),
});

const fetchWithFallback = async (...args) => {
  if (typeof global.fetch === 'function') {
    return global.fetch(...args);
  }

  try {
    const { default: fetchFn } = await import('node-fetch');
    return fetchFn(...args);
  } catch (error) {
    throw new Error('Fetch API is not available in this environment. Install node-fetch to enable ElevenLabs integration.');
  }
};

const resolveElevenLabsKey = (providedKey) => {
  const key = (providedKey || appSettings.elevenlabsApiKey || process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key || isMaskedPlaceholderValue(key)) {
    return null;
  }
  return key;
};

const withAbortSignal = (timeoutMs = ELEVENLABS_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
    },
  };
};

async function elevenLabsRequest(pathname, { method = 'GET', body, headers = {}, apiKey, responseType } = {}) {
  const key = resolveElevenLabsKey(apiKey);
  if (!key) {
    const error = new Error('ElevenLabs API key not configured');
    error.status = 503;
    throw error;
  }

  const url = new URL(pathname, ELEVENLABS_BASE_URL);
  const init = {
    method,
    headers: {
      'xi-api-key': key,
      ...headers,
    },
  };

  if (body !== undefined) {
    if (!(body instanceof Buffer) && typeof body !== 'string') {
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      init.body = JSON.stringify(body);
    } else {
      init.body = body;
    }
  }

  const { signal, cleanup } = withAbortSignal();
  init.signal = signal;

  try {
    const response = await fetchWithFallback(url, init);
    cleanup();

    if (!response.ok) {
      const raw = await response.text().catch(() => '');
      let details;
      try {
        details = raw ? JSON.parse(raw) : undefined;
      } catch {
        details = raw ? { message: raw } : undefined;
      }
      const error = new Error(details?.message || details?.error || response.statusText);
      error.status = response.status;
      error.details = details;
      throw error;
    }

    if (responseType === 'buffer') {
      const buffer = await response.arrayBuffer();
      return Buffer.from(buffer);
    }

    if (responseType === 'stream') {
      return response.body;
    }

    if (response.status === 204) {
      return null;
    }

    const text = await response.text();
    if (!text) {
      return null;
    }

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('ElevenLabs request timed out');
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  }
}

async function fetchElevenLabsVoices({ apiKey, forceRefresh = false } = {}) {
  await ensureSettingsLoaded();
  const cache = memoryStore.elevenLabs || { voices: [], lastFetched: 0 };
  const now = Date.now();
  const cacheValid = !forceRefresh && cache.voices?.length && (now - cache.lastFetched) < ELEVENLABS_CACHE_TTL_MS;

  if (cacheValid) {
    return cache.voices;
  }

  const result = await elevenLabsRequest('/v1/voices', { apiKey });
  const voices = Array.isArray(result?.voices) ? result.voices : Array.isArray(result) ? result : [];

  memoryStore.elevenLabs = {
    voices,
    lastFetched: now,
  };

  return voices;
}

function sanitizeVoiceSummary(voice) {
  if (!voice) return null;

  return {
    id: voice.voice_id || voice.id,
    name: voice.name,
    category: voice.category || voice.voice_category || null,
    labels: voice.labels || voice.tags || {},
    description: voice.description || '',
    preview_url: voice.preview_url || voice.previewUrl || null,
    language: voice.language || voice?.preview?.language || null,
    settings: voice.settings || voice.voice_settings || undefined,
  };
}

function mapVoicesResponse(voices) {
  return voices.map((voice) => sanitizeVoiceSummary(voice)).filter(Boolean);
}

const buildVoiceSettingsPayload = (options = {}) => {
  const voiceSettings = {
    stability: options.stability,
    similarity_boost: options.similarity_boost,
    style: options.style,
    use_speaker_boost: options.use_speaker_boost,
  };

  Object.keys(voiceSettings).forEach((key) => {
    if (voiceSettings[key] === undefined || voiceSettings[key] === null) {
      delete voiceSettings[key];
    }
  });

  return Object.keys(voiceSettings).length ? { voice_settings: voiceSettings } : {};
};

async function elevenLabsTextToSpeech(voiceId, text, options = {}) {
  const payload = {
    text,
    ...(options.model_id ? { model_id: options.model_id } : {}),
    ...buildVoiceSettingsPayload(options),
  };

  return elevenLabsRequest(`/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    body: payload,
    headers: {
      Accept: 'audio/mpeg',
    },
    responseType: 'buffer',
  });
}

async function appendClientLogs(entries) {
  if (!entries || entries.length === 0) {
    return;
  }

  const sanitized = entries
    .filter((entry) => entry && typeof entry === 'object')
    .slice(-MAX_LOG_PAYLOAD);

  if (!sanitized.length) {
    return;
  }

  try {
    ensureLogsDir();
    const payload = sanitized.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
    await fsPromises.appendFile(CLIENT_LOG_FILE, payload, 'utf-8');
  } catch (error) {
    console.warn('Failed to persist client logs:', error.message);
  }
}

function buildClientLogEntries(logs, context = {}) {
  if (!Array.isArray(logs)) {
    return [];
  }

  return logs
    .filter((log) => log && typeof log === 'object')
    .map((log) => {
      let resolvedMessage;
      const payload = log.message ?? log;

      if (typeof payload === 'string') {
        resolvedMessage = payload;
      } else if (payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string') {
        resolvedMessage = payload.message;
      } else {
        try {
          resolvedMessage = JSON.stringify(payload ?? '');
        } catch (error) {
          resolvedMessage = String(payload ?? '[unserializable]');
        }
      }

      let timestamp = log.timestamp;
      if (!timestamp) {
        timestamp = new Date().toISOString();
      } else {
        try {
          timestamp = new Date(timestamp).toISOString();
        } catch {
          timestamp = new Date().toISOString();
        }
      }

      return {
        level: log.method || log.level || 'log',
        message: resolvedMessage,
        timestamp,
        source: 'client',
        ...context,
      };
    });
}
const nowIso = () => new Date().toISOString();

const recalculateSecurityStatus = () => {
  const security = memoryStore.security;
  if (!security || !security.status) {
    return;
  }

  const zones = security.alarm?.zones || [];
  security.status.zoneCount = zones.length;
  security.status.activeZones = zones.filter((zone) => zone && zone.enabled !== false && !zone.bypassed).length;
  security.status.bypassedZones = zones.filter((zone) => zone?.bypassed).length;
};

const applyAlarmState = (state, { actor, event } = {}) => {
  const security = memoryStore.security;
  if (!security || !security.status || !security.alarm) {
    return;
  }

  const timestamp = nowIso();
  security.status.alarmState = state;
  security.alarm.alarmState = state;
  security.status.isTriggered = state === 'triggered';
  security.status.isArmed = state === 'armedStay' || state === 'armedAway';

  if (security.status.isArmed) {
    security.status.lastArmed = timestamp;
    security.alarm.lastArmed = timestamp;
    security.status.armedBy = actor || 'system';
    security.alarm.armedBy = actor || 'system';
  } else if (event === 'disarm' || !security.status.isArmed) {
    security.status.lastDisarmed = timestamp;
    security.alarm.lastDisarmed = timestamp;
    security.alarm.disarmedBy = actor || 'system';
    security.status.armedBy = null;
    security.alarm.zones = (security.alarm.zones || []).map((zone) => ({ ...zone, bypassed: false }));
  }

  if (state === 'triggered') {
    security.status.lastTriggered = timestamp;
    security.alarm.lastTriggered = timestamp;
  }

  recalculateSecurityStatus();
};
const testMockProvider = (provider) => ({
  provider,
  ok: true,
  latencyMs: 120,
  timestamp: new Date().toISOString(),
});

const app = express();

app.enable('trust proxy');

app.use((req, res, next) => {
  if (appSettings.sslEnabled && appSettings.sslForceHttps && !req.secure) {
    const host = req.headers.host || req.hostname;
    return res.redirect(301, `https://${host}${req.originalUrl}`);
  }
  return next();
});

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
const MAX_LOG_PAYLOAD = Number(process.env.CLIENT_LOG_MAX_ENTRIES || 200);

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
app.post('/api/auth/register', (_req, res) => {
  return sendError(res, 403, 'Self-service account creation is disabled. Please contact the administrator.');
});

app.post('/api/auth/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return sendError(res, 400, 'Email and password are required');
  }

  const user = await verifyUserCredentials(email, password);
  if (!user) {
    return sendError(res, 401, 'Invalid email or password');
  }

  const loginAt = new Date().toISOString();
  const updatedUser = updateUser(user.id, { lastLoginAt: loginAt, requiresPasswordChange: false });
  const refreshToken = rotateRefreshToken(user.id);
  if (!refreshToken) {
    return sendError(res, 500, 'Unable to issue refresh token');
  }

  const accessToken = `hb-access-${randomUUID()}`;
  const authPayload = {
    accessToken,
    refreshToken,
    user: sanitizeUser(updatedUser || user),
  };

  return sendSuccess(res, authPayload);
}));

app.post('/api/auth/refresh', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) {
    return sendError(res, 400, 'refreshToken is required');
  }

  const user = findUserByRefreshToken(refreshToken);
  if (!user || user.isActive === false) {
    return sendError(res, 401, 'Invalid refresh token');
  }

  const nextRefreshToken = rotateRefreshToken(user.id);
  if (!nextRefreshToken) {
    return sendError(res, 500, 'Unable to refresh session');
  }

  const accessToken = `hb-access-${randomUUID()}`;
  const authPayload = {
    accessToken,
    refreshToken: nextRefreshToken,
    user: sanitizeUser(user),
  };

  return sendSuccess(res, authPayload);
}));

app.post('/api/auth/logout', asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    revokeRefreshToken(refreshToken);
  }
  return sendSuccess(res, { message: 'Logged out' });
}));

app.post('/logs', asyncHandler(async (req, res) => {
  const { logs = [], domMetrics = {}, url } = req.body || {};
  const userAgent = req.headers['user-agent'];
  let entries = [];

  try {
    entries = buildClientLogEntries(logs, {
      domMetrics,
      url: url || req.headers.referer || null,
      userAgent,
      receivedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.warn('Failed to normalize client logs:', error.message);
    entries = [];
  }

  if (entries.length) {
    try {
      await appendClientLogs(entries);
    } catch (error) {
      console.warn('Failed to persist client logs:', error.message);
    }
  }

  return res.status(204).end();
}));
const SENSITIVE_PLACEHOLDER_PATTERN = /^\u0007+/;
const SENSITIVE_KEYS = new Set([
  'elevenlabsApiKey',
  'smartthingsToken',
  'smartthingsClientSecret',
  'openaiApiKey',
  'anthropicApiKey',
  'insteonAuthToken',
  ...SSL_SENSITIVE_KEYS,
]);

function stripSensitivePlaceholders(partialSettings, currentSettings) {
  const result = { ...partialSettings };
  for (const key of Object.keys(partialSettings)) {
    if (SENSITIVE_KEYS.has(key) && typeof partialSettings[key] === 'string') {
      const value = partialSettings[key];
      if (SENSITIVE_PLACEHOLDER_PATTERN.test(value) || isMaskedPlaceholderValue(value)) {
        if (currentSettings && currentSettings[key] !== undefined) {
          result[key] = currentSettings[key];
        } else {
          delete result[key];
        }
      }
    }
  }
  return result;
}

app.get('/api/settings', asyncHandler(async (req, res) => {
  const settings = await ensureSettingsLoaded();
  return sendSuccess(res, { settings: maskSensitiveSettings(settings) });
}));

app.put('/api/settings', asyncHandler(async (req, res) => {
  await ensureSettingsLoaded();
  const updates = req.body || {};
  const merged = stripSensitivePlaceholders(updates, appSettings);

  if (merged.sslEnabled !== undefined) {
    merged.sslEnabled = merged.sslEnabled === true || merged.sslEnabled === 'true' || merged.sslEnabled === 1 || merged.sslEnabled === '1';
  }
  if (merged.sslForceHttps !== undefined) {
    merged.sslForceHttps = merged.sslForceHttps === true || merged.sslForceHttps === 'true' || merged.sslForceHttps === 1 || merged.sslForceHttps === '1';
  }

  const saved = await writeSettingsPersisted(merged);
  appSettings = { ...DEFAULT_SETTINGS, ...saved };
  normalizeSslFields(appSettings);
  ensureInsteonEnabledFlag();
  invalidateInsteonClient();
  await refreshInsteonRuntime({ reason: 'settings_updated' });
  await applySslConfiguration({ reason: 'settings_updated' });
  return sendSuccess(res, { message: 'Settings updated', settings: maskSensitiveSettings(appSettings) });
}));

app.get('/api/settings/:key', asyncHandler(async (req, res) => {
  await ensureSettingsLoaded();
  const key = req.params.key;
  if (!(key in appSettings)) {
    return sendError(res, 404, 'Setting not found');
  }
  return sendSuccess(res, { key, value: appSettings[key] });
}));
app.post('/api/settings/test-elevenlabs', asyncHandler(async (req, res) => {
  await ensureSettingsLoaded();
  const { apiKey } = req.body || {};
  const resolvedKey = resolveElevenLabsKey(apiKey);

  if (!resolvedKey) {
    return sendError(res, 400, 'apiKey required');
  }

  try {
    const voices = await fetchElevenLabsVoices({ apiKey: resolvedKey, forceRefresh: true });
    appSettings.elevenlabsApiKey = resolvedKey;
    await writeSettingsPersisted({ elevenlabsApiKey: resolvedKey });

    return sendSuccess(res, {
      message: 'ElevenLabs key validated',
      voiceCount: voices.length,
      voices: mapVoicesResponse(voices),
    });
  } catch (error) {
    const status = error.status ?? 500;
    const message = error.message || 'Failed to validate ElevenLabs key';
    return sendError(res, status, message, error.details);
  }
}));
app.get('/api/insteon/status', asyncHandler(async (req, res) => {
  await ensureSettingsLoaded();
  const enabled = !!appSettings.insteonEnabled;
  const refreshStatus = req.query.refresh === 'true';
  if (!enabled) {
    const snapshot = memoryStore.insteon.bridgeStatus || null;
    return sendSuccess(res, {
      enabled: false,
      bridgeUrl: resolveInsteonBaseUrl(),
      port: appSettings.insteonPort,
      bridgeStatus: snapshot,
      deviceCount: memoryStore.insteon.devices.length,
      lastSync: memoryStore.insteon.lastSync,
      pollInterval: getResolvedInsteonPollInterval(),
      lastError: memoryStore.insteon.lastError,
      mockMode: memoryStore.insteon.mock,
    });
  }

  try {
    if (!memoryStore.insteon.bridgeStatus || refreshStatus) {
      await fetchInsteonBridgeStatus();
    }
    return sendSuccess(res, {
      enabled: true,
      bridgeUrl: resolveInsteonBaseUrl(),
      port: appSettings.insteonPort,
      bridgeStatus: memoryStore.insteon.bridgeStatus,
      deviceCount: memoryStore.insteon.devices.length,
      lastSync: memoryStore.insteon.lastSync,
      pollInterval: getResolvedInsteonPollInterval(),
      lastError: memoryStore.insteon.lastError,
      mockMode: memoryStore.insteon.mock,
    });
  } catch (error) {
    const statusCode = error.status ?? 502;
    const details = recordInsteonError(error);
    return sendError(res, statusCode, error.message || 'Failed to query Insteon bridge', details);
  }
}));

app.get('/api/insteon/devices', asyncHandler(async (_req, res) => {
  await ensureSettingsLoaded();
  return sendSuccess(res, {
    enabled: !!appSettings.insteonEnabled,
    devices: deepClone(memoryStore.insteon.devices),
    count: memoryStore.insteon.devices.length,
    lastSync: memoryStore.insteon.lastSync,
    pollInterval: getResolvedInsteonPollInterval(),
    mockMode: memoryStore.insteon.mock,
  });
}));

app.get('/api/insteon/devices/:id', asyncHandler(async (req, res) => {
  await ensureSettingsLoaded();
  const device = getInsteonDeviceById(req.params.id);
  if (!device) {
    return sendError(res, 404, 'Insteon device not found');
  }
  return sendSuccess(res, { device: deepClone(device) });
}));

app.post('/api/insteon/sync', asyncHandler(async (req, res) => {
  await ensureSettingsLoaded();
  if (!appSettings.insteonEnabled) {
    return sendError(res, 409, 'Insteon integration is disabled');
  }
  try {
    const body = req.body || {};
    const refresh = body.refresh === false ? false : true;
    const summary = await syncInsteonDevices({ refresh, includeDevices: true });
    return sendSuccess(res, {
      message: 'Insteon discovery completed',
      deviceCount: summary.count,
      lastSync: summary.lastSync,
      mode: summary.mode,
      devices: summary.devices || [],
      mockMode: memoryStore.insteon.mock,
    });
  } catch (error) {
    const statusCode = error.status ?? 502;
    const details = recordInsteonError(error);
    return sendError(res, statusCode, error.message || 'Failed to sync Insteon devices', details);
  }
}));

app.post('/api/insteon/devices/:id/commands', asyncHandler(async (req, res) => {
  await ensureSettingsLoaded();
  if (!appSettings.insteonEnabled) {
    return sendError(res, 409, 'Insteon integration is disabled');
  }
  const deviceId = req.params.id;
  const payload = req.body || {};
  const command = payload.command;
  if (!command || typeof command !== 'string') {
    return sendError(res, 400, 'command is required');
  }
  try {
    const client = getInsteonClient();
    const commandPayload = { command, level: payload.level, fast: payload.fast, duration: payload.duration };
    const result = await client.sendCommand(deviceId, commandPayload);
    memoryStore.insteon.lastError = null;
    return sendSuccess(res, { message: 'Command dispatched', result });
  } catch (error) {
    const statusCode = error.status ?? 502;
    const details = recordInsteonError(error);
    return sendError(res, statusCode, error.message || 'Failed to send Insteon command', details);
  }
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
app.get('/api/security-alarm', asyncHandler(async (_req, res) => {
  if (isDbConnected() && SecurityAlarmModel) {
    const alarm = await SecurityAlarmModel.getMainAlarm();
    return sendSuccess(res, { alarm: alarm.toObject() });
  }

  return sendSuccess(res, { alarm: deepClone(memoryStore.security.alarm) });
}));

app.get('/api/security-alarm/status', asyncHandler(async (_req, res) => {
  recalculateSecurityStatus();
  return sendSuccess(res, { status: deepClone(memoryStore.security.status) });
}));

app.post('/api/security-alarm/arm', asyncHandler(async (req, res) => {
  const { mode } = req.body || {};
  if (!['stay', 'away'].includes(mode)) {
    return sendError(res, 400, 'mode must be "stay" or "away"');
  }

  const actor = req.user?.name || req.user?.email || 'system';

  if (isDbConnected() && SecurityAlarmModel) {
    const alarm = await SecurityAlarmModel.getMainAlarm();
    await alarm.arm(mode, actor);
    return sendSuccess(res, { message: `Security system armed (${mode})`, alarm: alarm.toObject() });
  }

  const state = mode === 'stay' ? 'armedStay' : 'armedAway';
  applyAlarmState(state, { actor, event: 'arm' });
  recalculateSecurityStatus();

  return sendSuccess(res, {
    message: `Security system armed (${mode})`,
    alarm: deepClone(memoryStore.security.alarm),
    status: deepClone(memoryStore.security.status),
  });
}));

app.post('/api/security-alarm/disarm', asyncHandler(async (req, res) => {
  const actor = req.user?.name || req.user?.email || 'system';

  if (isDbConnected() && SecurityAlarmModel) {
    const alarm = await SecurityAlarmModel.getMainAlarm();
    await alarm.disarm(actor);
    return sendSuccess(res, { message: 'Security system disarmed', alarm: alarm.toObject() });
  }

  applyAlarmState('disarmed', { actor, event: 'disarm' });
  recalculateSecurityStatus();

  return sendSuccess(res, {
    message: 'Security system disarmed',
    alarm: deepClone(memoryStore.security.alarm),
    status: deepClone(memoryStore.security.status),
  });
}));

app.post('/api/security-alarm/zones', asyncHandler(async (req, res) => {
  const { name, deviceId, deviceType, enabled = true, bypassable = true } = req.body || {};
  if (!name || !deviceId || !deviceType) {
    return sendError(res, 400, 'name, deviceId, and deviceType are required');
  }

  if (isDbConnected() && SecurityAlarmModel) {
    const alarm = await SecurityAlarmModel.getMainAlarm();
    const zone = await alarm.addZone({ name, deviceId, deviceType, enabled, bypassable });
    return sendSuccess(res, { message: 'Zone added', alarm: alarm.toObject(), zone });
  }

  const zone = {
    zoneId: generateId('zone'),
    name,
    deviceId,
    deviceType,
    status: 'clear',
    enabled: Boolean(enabled),
    bypassable: Boolean(bypassable),
    bypassed: false,
    lastTriggered: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };

  memoryStore.security.alarm.zones.push(zone);
  recalculateSecurityStatus();

  return sendSuccess(res, {
    message: 'Zone added',
    alarm: deepClone(memoryStore.security.alarm),
    zone,
  }, 201);
}));

app.delete('/api/security-alarm/zones/:deviceId', asyncHandler(async (req, res) => {
  const { deviceId } = req.params;

  if (isDbConnected() && SecurityAlarmModel) {
    const alarm = await SecurityAlarmModel.getMainAlarm();
    await alarm.removeZone(deviceId);
    return sendSuccess(res, { message: 'Zone removed', alarm: alarm.toObject() });
  }

  const zones = memoryStore.security.alarm.zones;
  const index = zones.findIndex((zone) => zone.deviceId === deviceId);
  if (index === -1) {
    return sendError(res, 404, 'Zone not found');
  }

  zones.splice(index, 1);
  recalculateSecurityStatus();

  return sendSuccess(res, {
    message: 'Zone removed',
    alarm: deepClone(memoryStore.security.alarm),
  });
}));

app.put('/api/security-alarm/zones/:deviceId/bypass', asyncHandler(async (req, res) => {
  const { deviceId } = req.params;
  const { bypass } = req.body || {};

  if (typeof bypass !== 'boolean') {
    return sendError(res, 400, 'bypass must be a boolean');
  }

  if (isDbConnected() && SecurityAlarmModel) {
    const alarm = await SecurityAlarmModel.getMainAlarm();
    await alarm.bypassZone(deviceId, bypass);
    return sendSuccess(res, { message: bypass ? 'Zone bypassed' : 'Zone unbypassed', alarm: alarm.toObject() });
  }

  const zone = memoryStore.security.alarm.zones.find((item) => item.deviceId === deviceId);
  if (!zone) {
    return sendError(res, 404, 'Zone not found');
  }
  if (!zone.bypassable) {
    return sendError(res, 400, 'Zone is not bypassable');
  }

  zone.bypassed = bypass;
  zone.updatedAt = nowIso();
  recalculateSecurityStatus();

  return sendSuccess(res, {
    message: bypass ? 'Zone bypassed' : 'Zone unbypassed',
    alarm: deepClone(memoryStore.security.alarm),
  });
}));

app.post('/api/security-alarm/sync', asyncHandler(async (_req, res) => {
  if (!appSettings.smartthingsToken) {
    return sendError(res, 400, 'SmartThings token not configured');
  }

  if (memoryStore.security.alarm) {
    memoryStore.security.alarm.lastSyncWithSmartThings = nowIso();
  }
  return sendSuccess(res, {
    message: 'Security alarm synchronized',
    alarm: deepClone(memoryStore.security.alarm),
  });
}));

app.put('/api/security-alarm/configure', asyncHandler(async (req, res) => {
  const { smartthingsDeviceId } = req.body || {};
  if (!smartthingsDeviceId) {
    return sendError(res, 400, 'smartthingsDeviceId is required');
  }

  if (isDbConnected() && SecurityAlarmModel) {
    const alarm = await SecurityAlarmModel.getMainAlarm();
    alarm.smartthingsDeviceId = smartthingsDeviceId;
    await alarm.save();
    return sendSuccess(res, { message: 'Security alarm configured', alarm: alarm.toObject() });
  }

  memoryStore.security.alarm.smartthingsDeviceId = smartthingsDeviceId;
  return sendSuccess(res, {
    message: 'Security alarm configured',
    alarm: deepClone(memoryStore.security.alarm),
  });
}));

app.delete('/api/maintenance/devices/smartthings', asyncHandler(async (_req, res) => {
  const before = getMemoryStoreCounts();
  const deletedCount = before.smartthingsDevices;
  memoryStore.smartthings.devices = [];
  memoryStore.smartthings.scenes = [];
  const after = getMemoryStoreCounts();
  return sendSuccess(res, {
    message: 'SmartThings devices cleared',
    deletedCount,
    results: { before, after },
    shouldReload: true,
  });
}));

app.delete('/api/maintenance/devices/insteon', asyncHandler(async (_req, res) => {
  const before = getMemoryStoreCounts();
  const filterFn = (device) => {
    const marker = (device.protocol || device.source || '').toLowerCase();
    const id = String(device._id || device.id || '').toLowerCase();
    return marker !== 'insteon' && !id.startsWith('insteon-');
  };
  memoryStore.devices = memoryStore.devices.filter(filterFn);
  applyInsteonDeviceSnapshot([], { lastSync: null, summary: null });
  memoryStore.insteon.lastError = null;
  memoryStore.insteon.bridgeStatus = null;
  const after = getMemoryStoreCounts();
  const deletedCount = Math.max(0, (before.insteonDevices || 0) - (after.insteonDevices || 0));
  return sendSuccess(res, {
    message: 'Insteon devices cleared',
    deletedCount,
    results: { before, after },
    shouldReload: true,
  });
}));

app.delete('/api/maintenance/fake-data', asyncHandler(async (_req, res) => {
  const before = getMemoryStoreCounts();
  resetMemoryStore({ includeSamples: false, loadProfiles: false });
  writeUserProfilesToDisk(memoryStore.userProfiles);
  const after = getMemoryStoreCounts();

  return sendSuccess(res, {
    message: 'Demo data cleared',
    results: { before, after, cleared: before },
    shouldReload: true,
  });
}));

app.post('/api/maintenance/fake-data', asyncHandler(async (_req, res) => {
  const before = getMemoryStoreCounts();
  resetMemoryStore({ includeSamples: true, loadProfiles: true });
  const after = getMemoryStoreCounts();

  return sendSuccess(res, {
    message: 'Demo data reloaded',
    results: { before, after, injected: after },
    shouldReload: true,
  });
}));

app.post('/api/maintenance/sync/insteon', asyncHandler(async (req, res) => {
  await ensureSettingsLoaded();
  if (!appSettings.insteonEnabled) {
    return sendError(res, 409, 'Insteon integration is disabled');
  }
  try {
    const body = req.body || {};
    const refresh = body.refresh === false ? false : true;
    const summary = await syncInsteonDevices({ refresh, includeDevices: false });
    return sendSuccess(res, {
      message: 'Insteon discovery completed',
      deviceCount: summary.count,
      lastSync: summary.lastSync,
      mode: summary.mode,
    });
  } catch (error) {
    const status = error.status ?? 502;
    const details = recordInsteonError(error);
    return sendError(res, status, error.message || 'Failed to sync Insteon devices', details);
  }
}));

app.post('/api/maintenance/test-insteon', asyncHandler(async (_req, res) => {
  await ensureSettingsLoaded();
  try {
    const status = await fetchInsteonBridgeStatus({ allowDisabled: true });
    return sendSuccess(res, {
      message: 'Insteon bridge reachable',
      enabled: !!appSettings.insteonEnabled,
      bridgeUrl: resolveInsteonBaseUrl(),
      port: appSettings.insteonPort,
      status,
    });
  } catch (error) {
    const statusCode = error.status ?? 502;
    const details = recordInsteonError(error);
    return sendError(res, statusCode, error.message || 'Failed to reach Insteon bridge', details);
  }
}));

app.get('/api/profiles', asyncHandler(async (_req, res) => {
  if (isDbConnected() && UserProfileModel) {
    const docs = await UserProfileModel.find().lean();
    return sendSuccess(res, { profiles: docs, count: docs.length });
  }

  return sendSuccess(res, { profiles: deepClone(memoryStore.userProfiles), count: memoryStore.userProfiles.length });
}));

app.get('/api/profiles/voices', asyncHandler(async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const voices = await fetchElevenLabsVoices({ forceRefresh });
    return sendSuccess(res, { voices: mapVoicesResponse(voices), count: voices.length });
  } catch (error) {
    const status = error.status ?? 500;
    const message = error.message || 'Failed to load ElevenLabs voices';
    return sendError(res, status, message, error.details);
  }
}));

app.get('/api/profiles/voices/:voiceId', asyncHandler(async (req, res) => {
  const { voiceId } = req.params;
  try {
    const voice = await elevenLabsRequest(`/v1/voices/${voiceId}`);
    return sendSuccess(res, { voice });
  } catch (error) {
    const status = error.status ?? 500;
    const message = error.message || 'Failed to load voice details';
    return sendError(res, status, message, error.details);
  }
}));

app.post('/api/profiles/voices/:voiceId/validate', asyncHandler(async (req, res) => {
  const { voiceId } = req.params;
  try {
    await elevenLabsRequest(`/v1/voices/${voiceId}`);
    return sendSuccess(res, { valid: true, voiceId });
  } catch (error) {
    if (error.status === 404) {
      return sendSuccess(res, { valid: false, voiceId });
    }
    const status = error.status ?? 500;
    const message = error.message || 'Failed to validate voice';
    return sendError(res, status, message, error.details);
  }
}));

app.get('/api/profiles/wake-word/:wakeWord', asyncHandler(async (req, res) => {
  const wakeWord = String(req.params.wakeWord || '').toLowerCase();

  if (isDbConnected() && UserProfileModel) {
    const regex = new RegExp(`^${wakeWord}$`, 'i');
    const docs = await UserProfileModel.find({ wakeWords: regex }).lean();
    return sendSuccess(res, { profiles: docs, count: docs.length });
  }

  const profiles = memoryStore.userProfiles.filter((profile) =>
    (profile.wakeWords || []).some((word) => word.toLowerCase() === wakeWord)
  );
  return sendSuccess(res, { profiles: deepClone(profiles), count: profiles.length });
}));

app.get('/api/profiles/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (isDbConnected() && UserProfileModel) {
    const doc = await UserProfileModel.findById(id).lean();
    if (!doc) {
      return sendError(res, 404, 'Profile not found');
    }
    return sendSuccess(res, { profile: doc });
  }

  const profile = memoryStore.userProfiles.find((item) => item._id === id);
  if (!profile) {
    return sendError(res, 404, 'Profile not found');
  }
  return sendSuccess(res, { profile: deepClone(profile) });
}));

app.post('/api/profiles', asyncHandler(async (req, res) => {
  const payload = req.body || {};
  const name = (payload.name || '').trim();
  const systemPrompt = (payload.systemPrompt || '').trim();
  const voiceId = (payload.voiceId || '').trim();
  const wakeWordsInput = payload.wakeWords;
  const wakeWords = Array.isArray(wakeWordsInput)
    ? wakeWordsInput.map((word) => String(word).trim()).filter(Boolean)
    : String(wakeWordsInput || '')
        .split(',')
        .map((word) => word.trim())
        .filter(Boolean);

  if (!name || !systemPrompt || !voiceId || wakeWords.length === 0) {
    return sendError(res, 400, 'name, systemPrompt, voiceId, and wakeWords are required');
  }

  if (isDbConnected() && UserProfileModel) {
    const doc = await UserProfileModel.create({ ...payload, name, systemPrompt, voiceId, wakeWords });
    return sendSuccess(res, { message: 'Profile created', profile: doc.toObject() }, 201);
  }

  const timestamp = nowIso();
  const newProfile = {
    _id: generateId('profile'),
    name,
    wakeWords,
    voiceId,
    voiceName: payload.voiceName || '',
    systemPrompt,
    personality: payload.personality || 'friendly',
    responseStyle: payload.responseStyle || 'conversational',
    preferredLanguage: payload.preferredLanguage || 'en-US',
    timezone: payload.timezone || 'UTC',
    speechRate: Number(payload.speechRate ?? 1),
    speechPitch: Number(payload.speechPitch ?? 1),
    active: payload.active !== undefined ? Boolean(payload.active) : true,
    permissions: Array.isArray(payload.permissions) ? payload.permissions : [],
    lastUsed: null,
    usageCount: 0,
    avatar: payload.avatar || null,
    birthDate: payload.birthDate || null,
    favorites: {
      devices: [],
      scenes: [],
      automations: [],
    },
    contextMemory: payload.contextMemory !== undefined ? Boolean(payload.contextMemory) : true,
    learningMode: payload.learningMode !== undefined ? Boolean(payload.learningMode) : true,
    privacyMode: payload.privacyMode !== undefined ? Boolean(payload.privacyMode) : false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  memoryStore.userProfiles.push(newProfile);
  writeUserProfilesToDisk(memoryStore.userProfiles);

  return sendSuccess(res, { message: 'Profile created', profile: deepClone(newProfile) }, 201);
}));

app.put('/api/profiles/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const updates = req.body || {};

  if (isDbConnected() && UserProfileModel) {
    const doc = await UserProfileModel.findByIdAndUpdate(id, updates, { new: true });
    if (!doc) {
      return sendError(res, 404, 'Profile not found');
    }
    return sendSuccess(res, { message: 'Profile updated', profile: doc.toObject() });
  }

  const profile = memoryStore.userProfiles.find((item) => item._id === id);
  if (!profile) {
    return sendError(res, 404, 'Profile not found');
  }

  Object.assign(profile, updates);
  profile.updatedAt = nowIso();

  if (updates.wakeWords) {
    const wakeWordsUpdate = Array.isArray(updates.wakeWords)
      ? updates.wakeWords
      : String(updates.wakeWords || '')
          .split(',')
          .map((word) => word.trim())
          .filter(Boolean);
    profile.wakeWords = wakeWordsUpdate;
  }

  writeUserProfilesToDisk(memoryStore.userProfiles);
  return sendSuccess(res, { message: 'Profile updated', profile: deepClone(profile) });
}));

app.delete('/api/profiles/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (isDbConnected() && UserProfileModel) {
    const doc = await UserProfileModel.findByIdAndDelete(id);
    if (!doc) {
      return sendError(res, 404, 'Profile not found');
    }
    return sendSuccess(res, { message: 'Profile deleted', profile: doc.toObject() });
  }

  const index = memoryStore.userProfiles.findIndex((item) => item._id === id);
  if (index === -1) {
    return sendError(res, 404, 'Profile not found');
  }

  const [removed] = memoryStore.userProfiles.splice(index, 1);
  writeUserProfilesToDisk(memoryStore.userProfiles);
  return sendSuccess(res, { message: 'Profile deleted', profile: removed });
}));

app.patch('/api/profiles/:id/toggle', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (isDbConnected() && UserProfileModel) {
    const doc = await UserProfileModel.findById(id);
    if (!doc) {
      return sendError(res, 404, 'Profile not found');
    }
    doc.active = !doc.active;
    await doc.save();
    return sendSuccess(res, { message: doc.active ? 'Profile activated' : 'Profile deactivated', profile: doc.toObject() });
  }

  const profile = memoryStore.userProfiles.find((item) => item._id === id);
  if (!profile) {
    return sendError(res, 404, 'Profile not found');
  }
  profile.active = !profile.active;
  profile.updatedAt = nowIso();
  writeUserProfilesToDisk(memoryStore.userProfiles);

  return sendSuccess(res, {
    message: profile.active ? 'Profile activated' : 'Profile deactivated',
    profile: deepClone(profile),
  });
}));

app.patch('/api/profiles/:id/usage', asyncHandler(async (req, res) => {
  const { id } = req.params;

  if (isDbConnected() && UserProfileModel) {
    const doc = await UserProfileModel.findById(id);
    if (!doc) {
      return sendError(res, 404, 'Profile not found');
    }
    doc.usageCount = (doc.usageCount || 0) + 1;
    doc.lastUsed = new Date();
    await doc.save();
    return sendSuccess(res, { message: 'Profile usage updated', profile: doc.toObject() });
  }

  const profile = memoryStore.userProfiles.find((item) => item._id === id);
  if (!profile) {
    return sendError(res, 404, 'Profile not found');
  }
  profile.usageCount = (profile.usageCount || 0) + 1;
  profile.lastUsed = nowIso();
  profile.updatedAt = nowIso();
  writeUserProfilesToDisk(memoryStore.userProfiles);

  return sendSuccess(res, { message: 'Profile usage updated', profile: deepClone(profile) });
}));

app.post('/api/profiles/:id/favorites/devices', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { deviceId } = req.body || {};
  if (!deviceId) {
    return sendError(res, 400, 'deviceId is required');
  }

  if (isDbConnected() && UserProfileModel) {
    const doc = await UserProfileModel.findById(id);
    if (!doc) {
      return sendError(res, 404, 'Profile not found');
    }
    if (!doc.favorites) doc.favorites = { devices: [], scenes: [], automations: [] };
    if (!doc.favorites.devices.includes(deviceId)) {
      doc.favorites.devices.push(deviceId);
      await doc.save();
    }
    return sendSuccess(res, { message: 'Favorite device added', profile: doc.toObject() });
  }

  const profile = memoryStore.userProfiles.find((item) => item._id === id);
  if (!profile) {
    return sendError(res, 404, 'Profile not found');
  }
  if (!profile.favorites) {
    profile.favorites = { devices: [], scenes: [], automations: [] };
  }
  if (!profile.favorites.devices.includes(deviceId)) {
    profile.favorites.devices.push(deviceId);
  }
  profile.updatedAt = nowIso();
  writeUserProfilesToDisk(memoryStore.userProfiles);

  return sendSuccess(res, {
    message: 'Favorite device added',
    profile: deepClone(profile),
  });
}));

app.delete('/api/profiles/:id/favorites/devices/:deviceId', asyncHandler(async (req, res) => {
  const { id, deviceId } = req.params;

  if (isDbConnected() && UserProfileModel) {
    const doc = await UserProfileModel.findById(id);
    if (!doc) {
      return sendError(res, 404, 'Profile not found');
    }
    if (doc.favorites?.devices) {
      doc.favorites.devices = doc.favorites.devices.filter((item) => String(item) !== String(deviceId));
      await doc.save();
    }
    return sendSuccess(res, { message: 'Favorite device removed', profile: doc.toObject() });
  }

  const profile = memoryStore.userProfiles.find((item) => item._id === id);
  if (!profile) {
    return sendError(res, 404, 'Profile not found');
  }
  if (profile.favorites?.devices) {
    profile.favorites.devices = profile.favorites.devices.filter((item) => String(item) !== String(deviceId));
    profile.updatedAt = nowIso();
    writeUserProfilesToDisk(memoryStore.userProfiles);
  }

  return sendSuccess(res, { message: 'Favorite device removed', profile: deepClone(profile) });
}));

app.get('/api/elevenlabs/voices', asyncHandler(async (req, res) => {
  try {
    const voices = await fetchElevenLabsVoices({ forceRefresh: req.query.refresh === 'true' });
    return sendSuccess(res, { voices: mapVoicesResponse(voices), count: voices.length });
  } catch (error) {
    const status = error.status ?? 500;
    const message = error.message || 'Failed to load ElevenLabs voices';
    return sendError(res, status, message, error.details);
  }
}));

app.get('/api/elevenlabs/voices/:voiceId', asyncHandler(async (req, res) => {
  const { voiceId } = req.params;
  try {
    const voice = await elevenLabsRequest(`/v1/voices/${voiceId}`);
    return sendSuccess(res, { voice });
  } catch (error) {
    const status = error.status ?? 500;
    const message = error.message || 'Failed to load voice';
    return sendError(res, status, message, error.details);
  }
}));

app.get('/api/elevenlabs/status', asyncHandler(async (_req, res) => {
  try {
    const voices = await fetchElevenLabsVoices();
    return sendSuccess(res, {
      status: {
        configured: Boolean(resolveElevenLabsKey()),
        apiKeyValid: true,
        totalVoices: voices.length,
        service: 'ElevenLabs',
        baseUrl: ELEVENLABS_BASE_URL,
      },
    });
  } catch (error) {
    const status = error.status ?? 500;
    const message = error.message || 'Failed to fetch ElevenLabs status';
    return sendError(res, status, message, error.details);
  }
}));

app.post('/api/elevenlabs/text-to-speech', asyncHandler(async (req, res) => {
  const { voiceId, text, options = {} } = req.body || {};
  if (!voiceId || !text) {
    return sendError(res, 400, 'voiceId and text are required');
  }

  try {
    const buffer = await elevenLabsTextToSpeech(voiceId, text, options);
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.status(200).send(buffer);
  } catch (error) {
    const status = error.status ?? 500;
    const message = error.message || 'Failed to generate speech';
    return sendError(res, status, message, error.details);
  }
}));

app.post('/api/elevenlabs/preview', asyncHandler(async (req, res) => {
  const { voiceId, text } = req.body || {};
  if (!voiceId) {
    return sendError(res, 400, 'voiceId is required');
  }
  const previewText = text || 'Hello from HomeBrain. Your smart home is ready.';

  try {
    const buffer = await elevenLabsTextToSpeech(voiceId, previewText, {});
    res.setHeader('Content-Type', 'audio/mpeg');
    return res.status(200).send(buffer);
  } catch (error) {
    const status = error.status ?? 500;
    const message = error.message || 'Failed to generate preview';
    return sendError(res, status, message, error.details);
  }
}));

app.post('/api/elevenlabs/voices/:voiceId/validate', asyncHandler(async (req, res) => {
  const { voiceId } = req.params;
  try {
    await elevenLabsRequest(`/v1/voices/${voiceId}`);
    return sendSuccess(res, { valid: true, voiceId });
  } catch (error) {
    if (error.status === 404) {
      return sendSuccess(res, { valid: false, voiceId });
    }
    const status = error.status ?? 500;
    const message = error.message || 'Failed to validate voice';
    return sendError(res, status, message, error.details);
  }
}));app.get('/api/devices', asyncHandler(async (req, res) => {
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

const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 3000);
const SETTINGS_DB_URI = process.env.DATABASE_URL || process.env.MONGODB_URI || null;
const SETTINGS_DB_TIMEOUT_MS = Number(process.env.MONGO_SERVER_SELECTION_TIMEOUT_MS || 2000);
const SETTINGS_DB_OPTIONS = { serverSelectionTimeoutMS: SETTINGS_DB_TIMEOUT_MS };

async function closeServerInstance(server, label) {
  if (!server) {
    return;
  }

  await new Promise((resolve) => {
    server.close((error) => {
      if (error) {
        console.warn(`[Server] Failed to close ${label} server: ${error.message}`);
      }
      resolve();
    });
  });
}

async function startHttpServer({ reason } = {}) {
  if (httpServerInstance && currentServerTransport === 'http') {
    return;
  }

  if (httpsServerInstance) {
    await closeServerInstance(httpsServerInstance, 'HTTPS');
    httpsServerInstance = null;
  }

  await new Promise((resolve, reject) => {
    const server = app.listen(PORT, HOST, () => {
      server.off('error', onError);
      currentServerTransport = 'http';
      httpServerInstance = server;
      console.log(`HomeBrain API listening on http://${HOST}:${PORT}${reason ? ` (${reason})` : ''}`);
      resolve();
    });

    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };

    server.on('error', onError);
  });
}

async function startHttpsServer(credentials, { reason } = {}) {
  if (httpServerInstance) {
    await closeServerInstance(httpServerInstance, 'HTTP');
    httpServerInstance = null;
  }

  if (httpsServerInstance) {
    await closeServerInstance(httpsServerInstance, 'HTTPS');
    httpsServerInstance = null;
  }

  await new Promise((resolve, reject) => {
    const server = https.createServer(credentials, app);

    const onError = (error) => {
      server.off('error', onError);
      reject(error);
    };

    server.on('error', onError);

    server.listen(PORT, HOST, () => {
      server.off('error', onError);
      httpsServerInstance = server;
      currentServerTransport = 'https';
      console.log(`HomeBrain API listening on https://${HOST}:${PORT}${reason ? ` (${reason})` : ''}`);
      resolve();
    });
  });
}

async function applySslConfiguration({ reason = 'update', throwOnError = true } = {}) {
  await ensureSettingsLoaded();

  if (!appSettings.sslEnabled) {
    if (httpsServerInstance) {
      await closeServerInstance(httpsServerInstance, 'HTTPS');
      httpsServerInstance = null;
    }
    if (!httpServerInstance) {
      await startHttpServer({ reason: 'ssl_disabled' });
    }
    if (appSettings.sslLastError) {
      appSettings.sslLastError = null;
      await writeSettingsPersisted({ sslLastError: null });
    }
    return { active: false, https: false };
  }

  try {
    const credentials = buildSslCredentials(appSettings);
    tls.createSecureContext(credentials);
    await startHttpsServer(credentials, { reason });
    const appliedAt = new Date().toISOString();
    appSettings.sslLastAppliedAt = appliedAt;
    appSettings.sslLastError = null;
    await writeSettingsPersisted({ sslLastAppliedAt: appliedAt, sslLastError: null });
    return { active: true, https: true };
  } catch (error) {
    const message = error.message || 'Failed to apply SSL certificate';
    console.error(`[SSL] ${message}`);
    appSettings.sslLastError = message;
    await writeSettingsPersisted({ sslLastError: message });
    await startHttpServer({ reason: 'ssl_error_fallback' });
    if (throwOnError) {
      if (!error.status) {
        const wrapped = new Error(message);
        wrapped.status = 400;
        throw wrapped;
      }
      throw error;
    }
    return { active: false, https: false, error: message };
  }
}

async function startServer() {
  await initializeUserStore();
  if (!DEFAULT_PASSWORD_FROM_ENV) {
    console.warn(`[Auth] Default admin account (${DEFAULT_ADMIN_EMAIL}) is using fallback credentials. Update HOMEBRAIN_ADMIN_PASSWORD to rotate immediately.`);
  } else {
    console.log(`[Auth] Default admin account ready: ${DEFAULT_ADMIN_EMAIL}`);
  }
  await ensureSettingsLoaded();
  normalizeSslFields(appSettings);
  await refreshInsteonRuntime({ reason: 'startup' });
  if (SETTINGS_DB_URI) {
    if (mongoose.connection.readyState === 0) {
      try {
        await mongoose.connect(SETTINGS_DB_URI, SETTINGS_DB_OPTIONS);
        console.log(`Settings database connected (${mongoose.connection.host}/${mongoose.connection.name})`);
      } catch (error) {
        console.warn('Settings database connection failed; continuing with file persistence only.', error.message);
      }
    } else if (mongoose.connection.readyState === 1) {
      console.log('Settings database already connected.');
    }
  } else {
    console.log('Settings DB URI not provided; using file persistence.');
  }

  await startHttpServer({ reason: 'startup' });
  await applySslConfiguration({ reason: 'startup', throwOnError: false });
}

startServer().catch((error) => {
  console.error('Failed to start HomeBrain server:', error);
  process.exit(1);
});

async function gracefulShutdown(signal) {
  console.log(`HomeBrain server received ${signal}; shutting down...`);
  await stopInsteonRuntime();
  try {
    writeUserProfilesToDisk(memoryStore.userProfiles);
  } catch (error) {
    console.warn('Failed to persist user profiles during shutdown:', error.message);
  }

  await closeServerInstance(httpsServerInstance, 'HTTPS');
  httpsServerInstance = null;
  await closeServerInstance(httpServerInstance, 'HTTP');
  httpServerInstance = null;

  if (mongoose.connection.readyState === 1) {
    try {
      await mongoose.connection.close();
      console.log('Settings database connection closed.');
    } catch (error) {
      console.warn('Error closing settings database connection:', error.message);
    }
  }
  process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
