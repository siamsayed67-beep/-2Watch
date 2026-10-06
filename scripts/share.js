'use strict';

/*
 * Starts the 2Watch server on this computer and opens a Cloudflare quick tunnel to it,
 * so anyone can reach it at a public https://….trycloudflare.com address.
 * Videos, rooms and chat stay on this machine; Cloudflare only relays the traffic.
 * Stop both with Ctrl+C.
 */

require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '.env') });
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const root = path.join(__dirname, '..');

function findCloudflared() {
  const candidates = [
    process.env.CLOUDFLARED_PATH,
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || 'cloudflared'; // fall back to PATH
}

const server = spawn(process.execPath, ['server.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: String(PORT) } });

const tunnel = spawn(findCloudflared(), ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let announced = false;
const onTunnelOutput = (chunk) => {
  const url = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
  if (url && !announced) {
    announced = true;
    const line = '='.repeat(64);
    console.log(`\n${line}\n  2Watch is live. Share this link:\n\n    ${url}\n\n  It works while this window stays open. Press Ctrl+C to stop.\n  (The link changes every time you start sharing again.)\n${line}\n`);
  }
};
tunnel.stdout.on('data', onTunnelOutput);
tunnel.stderr.on('data', onTunnelOutput);

tunnel.on('error', (err) => {
  if (err.code === 'ENOENT') {
    console.error('\ncloudflared was not found. Install it with:\n  winget install --id Cloudflare.cloudflared\nor set CLOUDFLARED_PATH in .env to where cloudflared.exe is.\n');
  } else {
    console.error('Could not start the tunnel:', err.message);
  }
  shutdown(1);
});

let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  tunnel.kill();
  server.kill();
  process.exit(code);
}

tunnel.on('exit', (code) => {
  if (!stopping) {
    console.error(`The tunnel stopped (exit code ${code}). Stopping the server too.`);
    shutdown(1);
  }
});
server.on('exit', (code) => {
  if (!stopping) {
    console.error(`The server stopped (exit code ${code}). Stopping the tunnel too.`);
    shutdown(1);
  }
});
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
