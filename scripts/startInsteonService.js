#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

const LOG_PREFIX = '[INSTEON]';
const serviceName = process.env.INSTEON_SERVICE || 'homebrain-insteon.service';
const systemctlCmd = process.env.INSTEON_SYSTEMCTL || 'systemctl';
const autoStartDisabled = process.env.INSTEON_AUTOSTART === '0';

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function warn(message) {
  console.warn(`${LOG_PREFIX} ${message}`);
}

if (autoStartDisabled) {
  log('Skipping automatic PLM service start (INSTEON_AUTOSTART=0).');
  process.exit(0);
}

if (process.platform !== 'linux') {
  log('Skipping automatic PLM service start (requires Linux systemd).');
  process.exit(0);
}

function run(cmd, args) {
  try {
    const result = spawnSync(cmd, args, { stdio: 'inherit' });
    if (result.error) {
      warn(`${cmd} failed: ${result.error.message}`);
      return result.status ?? 1;
    }
    return result.status ?? 0;
  } catch (error) {
    warn(`${cmd} threw: ${error.message}`);
    return 1;
  }
}

log(`Starting ${serviceName} via ${systemctlCmd}...`);
const status = run(systemctlCmd, ['start', serviceName]);

if (status === 0) {
  log(`${serviceName} started (or already running).`);
} else {
  warn('Could not start the PLM service automatically. Start it manually with:');
  warn(`  sudo systemctl start ${serviceName}`);
}

process.exit(0);
