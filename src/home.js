'use strict';
// Two more ways to open your nest, with the same page as the website:
//
//   pigeon app    your nest in a window of its own (no tabs, no address bar)
//   pigeon home   your own pigeon, running on this computer: your drive lives
//                 here instead of on the website, so it works with no website
//                 at all. --wifi lets other devices on your Wi-Fi open it too.

const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { open: openThing } = require('./tui');
const { home } = require('./nest');

const ROOT = path.join(__dirname, '..');

/** A browser that can open a page as an app window: [command, args] or null. */
function appBrowser(url) {
  const flag = `--app=${url}`;
  if (process.platform === 'darwin') {
    for (const name of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium', 'Arc', 'Vivaldi']) {
      if (fs.existsSync(`/Applications/${name}.app`) || fs.existsSync(path.join(os.homedir(), 'Applications', `${name}.app`))) return ['open', ['-na', name, '--args', flag, '--new-window']];
    }
    return null;
  }
  if (process.platform === 'win32') return ['cmd', ['/c', 'start', '""', 'msedge', flag]]; // Edge comes with Windows
  for (const cmd of ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
    if (spawnSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0) return [cmd, [flag]];
  }
  return null;
}

/** Open url as an app window if a browser can, else as a normal tab. Says which. */
function openAsApp(url) {
  const b = appBrowser(url);
  if (b) {
    try { spawn(b[0], b[1], { stdio: 'ignore', detached: true }).on('error', () => openThing(url)).unref(); return 'window'; } catch { /* fall through */ }
  }
  openThing(url);
  return 'tab';
}

/** Python 3, which runs pigeon's server: its command, or null. */
function python() {
  for (const cmd of process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python']) {
    const r = spawnSync(cmd, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (r.status === 0 && String(r.stdout).trim() === '3') return cmd;
  }
  return null;
}

function freePort(want) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => { const t = net.createServer(); t.listen(0, '127.0.0.1', () => { const p = t.address().port; t.close(() => resolve(p)); }); });
    s.listen(want, '127.0.0.1', () => s.close(() => resolve(want)));
  });
}

/** This computer's address on the local network (for --wifi), or null. */
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !/^169\.254\./.test(a.address)) return a.address;
  }
  return null;
}

/**
 * Start your own pigeon here. Resolves with { url, wifiUrl, data, stop } once
 * it answers. Your files are kept in ~/.pigeon/home (locked, like on the website).
 */
async function startHome({ port = 8787, wifi = false, data = path.join(home(), 'home') } = {}) {
  const py = python();
  if (!py) {
    const how = process.platform === 'darwin' ? 'On a Mac, type  xcode-select --install  and press Enter, then try again.' : 'Install Python 3 from python.org, then try again.';
    throw new Error(`pigeon home needs Python 3 to run, and it isn't on this computer yet. ${how}`);
  }
  fs.mkdirSync(data, { recursive: true });
  const p = await freePort(port);
  const host = wifi ? '0.0.0.0' : '127.0.0.1';
  const child = spawn(py, [path.join(ROOT, 'server', 'pigeon_server.py'), '--port', String(p), '--host', host, '--data', data, '--quota-mb', '51200'], { // it's your own disk: room for 50 GB
    stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PIGEON_HOME_MODE: '1', PIGEON_DATA: data },
  });
  let err = '';
  child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  const url = `http://127.0.0.1:${p}/`;
  // wait until it answers (or gives up)
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null) throw new Error(`pigeon home stopped straight away. ${err.trim().split('\n').pop() || ''}`.trim());
    try { const r = await fetch(url, { signal: AbortSignal.timeout(800) }); if (r.ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const ip = wifi ? lanAddress() : null;
  return { url, wifiUrl: ip ? `http://${ip}:${p}/` : null, data, port: p, stop: () => { try { child.kill(); } catch { /* gone */ } } };
}

module.exports = { openAsApp, appBrowser, startHome, python, lanAddress };
