'use strict';
// The roost: pigeon waiting quietly in the background, so things you send to
// this computer land by themselves, even when no pigeon window is open.
//
//   pigeon roost on      start now, and every time you log in (a macOS LaunchAgent)
//   pigeon roost off     stop
//   pigeon rules         where things land: photos in Pictures, PDFs in Documents, ...
//
// What it does when something lands:
//   - puts it where your rules say (folders are unpacked)
//   - text and links go on the clipboard
//   - shows a notification
//   - opens it, if the sender asked and your rules allow it (never apps or scripts)
//   - tells the sender it landed (a receipt)
// It also tells you when things you sent land elsewhere, and when someone
// drops a file in one of your drop boxes.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { Nest, home, downloads, session } = require('./nest');

const LABEL = 'dev.dpatel7.pigeon.roost';
const plistPath = () => path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const rulesPath = () => path.join(home(), 'rules.json');
const tilde = (p) => p.replace(os.homedir(), '~');
const untilde = (p) => String(p || '').replace(/^~(?=$|\/)/, os.homedir());

const KINDS = {
  image: { label: 'Photos and pictures', test: /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp|tiff?|svg)$/i, home: 'Pictures' },
  video: { label: 'Videos', test: /\.(mp4|mov|m4v|webm|mkv|avi)$/i, home: 'Movies' },
  audio: { label: 'Music and sound', test: /\.(mp3|m4a|wav|aac|flac|ogg|opus|aiff?)$/i, home: 'Music' },
  doc: { label: 'Documents (PDF, Word, slides…)', test: /\.(pdf|docx?|xlsx?|pptx?|key|pages|numbers|txt|md|rtf|csv|odt)$/i, home: 'Documents' },
  code: { label: 'Code', test: /\.(js|ts|py|java|c|cpp|h|rs|go|rb|php|swift|kt|cs|sh|html|css|json|lua|gd|ipynb)$/i, home: 'Downloads' },
  archive: { label: 'Zips and folders', test: /\.(zip|tar|gz|tgz|7z|rar)$/i, home: 'Downloads' },
};
// things a notification may open by itself: never apps, installers or scripts
const SAFE_OPEN = /\.(jpe?g|png|gif|webp|heic|pdf|txt|md|csv|mp4|mov|m4v|mp3|m4a|wav|docx?|xlsx?|pptx?|key|pages|numbers|rtf|html?)$/i;

function defaultRules() {
  const r = { default: tilde(downloads()), notify: true, clipboard: true, open: 'asked', links: 'clipboard' };
  for (const [k, v] of Object.entries(KINDS)) {
    const d = path.join(os.homedir(), v.home);
    r[k] = tilde(fs.existsSync(d) ? d : downloads());
  }
  return r;
}
function rules() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(rulesPath(), 'utf8')); } catch { /* defaults */ }
  return { ...defaultRules(), ...saved };
}
function saveRules(r) { fs.mkdirSync(home(), { recursive: true }); fs.writeFileSync(rulesPath(), JSON.stringify(r, null, 2)); }
const kindOf = (name) => Object.keys(KINDS).find((k) => KINDS[k].test.test(name)) || 'default';
function destFor(meta, r = rules()) {
  if (meta.kind === 'folder') return untilde(r.archive || r.default);
  return untilde(r[kindOf(meta.name || '')] || r.default);
}

// ── talking to the computer ──
function notify(title, text) {
  try {
    if (process.platform === 'darwin') {
      const q = (s) => JSON.stringify(String(s).slice(0, 180));
      spawnSync('osascript', ['-e', `display notification ${q(text)} with title ${q(title)}`], { stdio: 'ignore', timeout: 5000 });
    } else if (process.platform === 'linux') spawnSync('notify-send', [title, text], { stdio: 'ignore', timeout: 5000 });
  } catch { /* no notifications here */ }
}
function toClipboard(text) {
  const tries = process.platform === 'darwin' ? [['pbcopy', []]] : process.platform === 'win32' ? [['clip', []]] : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['-b', '-i']]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { input: text, stdio: ['pipe', 'ignore', 'ignore'], timeout: 5000 });
    if (r.status === 0) return true;
  }
  return false;
}
function fromClipboard() {
  const tries = process.platform === 'darwin' ? [['pbpaste', []]] : process.platform === 'win32' ? [['powershell', ['-NoProfile', '-Command', 'Get-Clipboard']]] : [['wl-paste', []], ['xclip', ['-selection', 'clipboard', '-o']], ['xsel', ['-b', '-o']]];
  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) return r.stdout;
  }
  return null;
}
function openThing(target) {
  const cmd = process.platform === 'darwin' ? ['open', [target]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', target]] : ['xdg-open', [target]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* fine */ }
}

/**
 * Land one thing that was sent to this computer. Returns { where, how } where
 * how is 'clipboard', 'saved' or 'opened'.
 */
async function land(nest, f, r = rules(), { say = () => {} } = {}) {
  const meta = f.meta || {};
  if (meta.clip) {
    const text = (await nest.bytes(f)).toString('utf8');
    const isLink = /^https?:\/\/\S+$/.test(text.trim());
    let how = 'saved', where = '';
    if (r.clipboard !== false && toClipboard(text)) how = 'clipboard';
    if (isLink && r.links === 'open') { openThing(text.trim()); how = 'opened'; }
    if (how === 'saved') where = await nest.get(f, untilde(r.default));
    await nest.got(f, true).catch(() => {});
    if (r.notify !== false) notify(`pigeon · from ${meta.from || 'another device'}`, how === 'clipboard' ? `Copied: ${text.trim().slice(0, 120)}` : how === 'opened' ? `Opened ${text.trim().slice(0, 100)}` : `Saved to ${tilde(where)}`);
    say(how === 'clipboard' ? `copied to the clipboard: ${text.trim().slice(0, 60)}` : how === 'opened' ? `opened ${text.trim().slice(0, 60)}` : `saved ${tilde(where)}`);
    return { where, how };
  }
  const dir = destFor(meta, r);
  const where = await nest.get(f, dir);
  await nest.got(f, !!meta.drop).catch(() => {});
  let how = 'saved';
  const allowed = r.open === 'always' || (r.open === 'asked' && meta.open);
  if (allowed && SAFE_OPEN.test(where) && fs.statSync(where).isFile()) { openThing(where); how = 'opened'; }
  if (r.notify !== false) notify(`pigeon · from ${meta.from || 'another device'}`, `${path.basename(where)} landed in ${tilde(path.dirname(where))}`);
  say(`${how === 'opened' ? 'opened' : 'saved'} ${tilde(where)}`);
  return { where, how };
}

/** Run until stopped: land what arrives, report receipts and drop-box arrivals. */
async function run({ say = (s) => process.stdout.write(`${new Date().toLocaleTimeString()}  ${s}\n`), once = false } = {}) {
  let nest = new Nest();
  if (!nest.in) throw new Error('Log in first: pigeon login');
  const statePath = path.join(home(), 'roost.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { /* first run */ }
  state.since = state.since || Date.now();
  state.seenBoxFiles = state.seenBoxFiles || [];
  const save = () => { try { fs.writeFileSync(statePath, JSON.stringify(state)); } catch { /* fine */ } };
  const landing = new Set();
  let quiet = 0, round = 0;
  say(`pigeon is roosting: things sent to ${require('./nest').device()} land by themselves.`);
  for (;;) {
    let busy = false;
    try {
      if (!nest.in) nest = new Nest();
      const r = rules();
      for (const f of await nest.inbox()) {
        if (landing.has(f.id)) continue;
        landing.add(f.id);
        try { await land(nest, f, r, { say }); busy = true; } catch (e) { say(`couldn't land ${f.meta.name}: ${e.message}`); landing.delete(f.id); }
      }
      if (round % 4 === 0) { // every minute or so: receipts, and new drop-box files
        const sent = await nest.sent({ since: state.since });
        for (const s of sent) {
          if (s.got && s.got > state.since) { if (rules().notify !== false) notify('pigeon', `${s.meta.name} landed`); say(`${s.meta.name} landed on another device`); }
        }
        state.since = Date.now();
        const { files } = await nest.list(); // (this also takes in drop-box arrivals)
        for (const f of files.filter((x) => x.box && x.adopted && !state.seenBoxFiles.includes(x.id))) {
          state.seenBoxFiles.push(f.id);
          if (rules().notify !== false) notify(`pigeon · drop box "${f.meta.box}"`, `${f.meta.from.replace(/ \(drop box\)$/, '')} sent ${f.meta.name}`);
          say(`new in drop box "${f.meta.box}": ${f.meta.name}`);
        }
        state.seenBoxFiles = state.seenBoxFiles.slice(-500);
        save();
      }
    } catch (e) {
      if (/log in/i.test(e.message)) { say('This computer was signed out of your nest. Run: pigeon login'); if (once) throw e; await sleep(300000); continue; }
      say(`(${e.message} - trying again soon)`);
    }
    if (once) return;
    round++;
    quiet = busy ? 0 : quiet + 1;
    await sleep(quiet > 40 ? 30000 : 15000); // slower after ten quiet minutes
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── starting it by itself (macOS) ──
function on() {
  if (process.platform !== 'darwin') {
    return { ok: false, why: 'Starting by itself is for Macs. Here, keep a window open with: pigeon roost run' };
  }
  const bin = path.join(__dirname, '..', 'bin', 'pigeon.js');
  const log = path.join(home(), 'roost.log');
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(process.execPath)}</string><string>${esc(bin)}</string><string>roost</string><string>run</string></array>
  <key>EnvironmentVariables</key><dict><key>PIGEON_HOME</key><string>${esc(home())}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${esc(log)}</string>
  <key>StandardErrorPath</key><string>${esc(log)}</string>
</dict></plist>
`;
  fs.mkdirSync(path.dirname(plistPath()), { recursive: true });
  fs.writeFileSync(plistPath(), plist);
  const uid = process.getuid();
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath()], { encoding: 'utf8' });
  if (r.status !== 0) {
    const r2 = spawnSync('launchctl', ['load', '-w', plistPath()], { encoding: 'utf8' });
    if (r2.status !== 0) return { ok: false, why: `macOS didn't start it (${(r.stderr || r2.stderr || '').trim() || 'launchctl said no'}). You can still run it in a window: pigeon roost run` };
  }
  session.save({ ...session.load(), roost: true });
  return { ok: true, log };
}

function off() {
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}/${LABEL}`], { stdio: 'ignore' });
    spawnSync('launchctl', ['unload', plistPath()], { stdio: 'ignore' });
    fs.rmSync(plistPath(), { force: true });
  }
  session.save({ ...session.load(), roost: false });
}

function status() {
  if (process.platform !== 'darwin') return { on: false, installed: false };
  const r = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${LABEL}`], { encoding: 'utf8' });
  return { installed: fs.existsSync(plistPath()), on: r.status === 0 && /state = running/.test(r.stdout || ''), log: path.join(home(), 'roost.log') };
}

module.exports = { run, on, off, status, land, rules, saveRules, defaultRules, destFor, kindOf, KINDS, toClipboard, fromClipboard, notify, tilde, untilde, openThing };
