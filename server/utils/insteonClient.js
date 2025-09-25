const { URL } = require('url');

let cachedFetch = null;

async function fetchWithFallback(url, options) {
  if (cachedFetch) {
    return cachedFetch(url, options);
  }
  if (typeof global.fetch === 'function') {
    cachedFetch = global.fetch.bind(global);
    return cachedFetch(url, options);
  }
  const { default: nodeFetch } = await import('node-fetch');
  cachedFetch = nodeFetch;
  return cachedFetch(url, options);
}

const DEFAULT_TIMEOUT_MS = 8000;

function normalizeBaseUrl(raw) {
  if (!raw) {
    return 'http://127.0.0.1:8765';
  }
  let trimmed = String(raw).trim();
  if (!trimmed) {
    return 'http://127.0.0.1:8765';
  }
  trimmed = trimmed.replace(/\/+$/, '');
  trimmed = trimmed.replace(/\/status$/i, '');
  return trimmed || 'http://127.0.0.1:8765';
}

function buildUrl(baseUrl, path) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  const relative = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(relative, `${normalizedBase}/`);
  return url.toString();
}

function createAbortController(timeoutMs) {
  const controller = new AbortController();
  if (timeoutMs > 0) {
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true });
  }
  return controller;
}

async function requestJson({
  baseUrl,
  path,
  method = 'GET',
  body,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  authToken,
}) {
  const controller = createAbortController(timeoutMs);
  const headers = { Accept: 'application/json' };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const url = buildUrl(baseUrl, path);
  const response = await fetchWithFallback(url, {
    method,
    headers,
    body: payload,
    signal: controller.signal,
  });

  const text = await response.text();
  let json;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch (error) {
      throw new Error(`Bridge returned invalid JSON from ${url}: ${error.message}`);
    }
  }

  if (!response.ok) {
    const details = json && typeof json === 'object' ? json : undefined;
    const message = details?.message || `Bridge request failed (${response.status})`;
    const error = new Error(message);
    error.status = response.status;
    error.details = details;
    throw error;
  }

  return json ?? {};
}

class InsteonClient {
  constructor({ baseUrl, authToken, timeoutMs } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.authToken = authToken || null;
    this.timeoutMs = typeof timeoutMs === 'number' && timeoutMs >= 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  async status() {
    return requestJson({ baseUrl: this.baseUrl, path: '/status', authToken: this.authToken, timeoutMs: this.timeoutMs });
  }

  async discovery({ refresh = true } = {}) {
    return requestJson({ baseUrl: this.baseUrl, path: '/discovery', method: 'POST', authToken: this.authToken, timeoutMs: this.timeoutMs, body: { refresh } });
  }

  async listDevices() {
    return requestJson({ baseUrl: this.baseUrl, path: '/devices', authToken: this.authToken, timeoutMs: this.timeoutMs });
  }

  async getDevice(deviceId) {
    return requestJson({ baseUrl: this.baseUrl, path: `/devices/${encodeURIComponent(deviceId)}`, authToken: this.authToken, timeoutMs: this.timeoutMs });
  }

  async sendCommand(deviceId, payload) {
    return requestJson({ baseUrl: this.baseUrl, path: `/devices/${encodeURIComponent(deviceId)}/command`, method: 'POST', authToken: this.authToken, timeoutMs: this.timeoutMs, body: payload });
  }
}

function createInsteonClient(options = {}) {
  return new InsteonClient(options);
}

module.exports = {
  createInsteonClient,
  InsteonClient,
  normalizeBaseUrl,
};
