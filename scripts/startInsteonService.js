#!/usr/bin/env node
"use strict";

const { spawnSync } = require('child_process');

const serviceName = process.env.INSTEON_SERVICE || 'homebrain-insteon.service';
const systemctlCmd = process.env.INSTEON_SYSTEMCTL || 'systemctl';

if (process.platform !== 'linux') {
  console.log('[INSTEON] Skipping automatic PLM service start (requires Linux systemd).');
  process.exit(0);
}

function run(cmd, args) {
  try {
    const result = spawnSync(cmd, args, { stdio: 'inherit' });
    if (result.error) {
      console.warn([INSTEON]  failed: );
      return result.status ?? 1;
    }
    return result.status ?? 0;
  } catch (error) {
    console.warn([INSTEON]  threw: );
    return 1;
  }
}

console.log([INSTEON] Starting  via ...);
const status = run(systemctlCmd, ['start', serviceName]);

if (status === 0) {
  console.log([INSTEON]  started (or already running).);
} else {
  console.warn('[INSTEON] Could not start the PLM service automatically. Start it manually with:');
  console.warn(  sudo systemctl start );
}

process.exit(0);
