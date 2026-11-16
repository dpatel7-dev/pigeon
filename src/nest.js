'use strict';
// Your nest: the account on a pigeon website, and everything that moves in
// and out of it. Sending locks a file piece by piece and uploads it; getting
// downloads the pieces and unlocks them. Folders travel as one bundle.

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./crypto');

const home = () => process.env.PIGEON_HOME || path.join(os.homedir(), '.pigeon');
const DEFAULT_SITE = 'https://djp7.pythonanywhere.com/pigeon';
const device = () => `${os.hostname().replace(/\.local$/, '').slice(0, 40)} (${{ darwin: 'Mac', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform})`;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/** The site this pigeon talks to: what you set, else where it was installed from, else the default. */
function site() {
  const s = readJson(path.join(home(), 'session.json'), {});
  if (s.site) return s.site;
  try {
    const hub = fs.readFileSync(path.join(home(), 'hub'), 'utf8').trim();
    if (/^https?:\/\//.test(hub)) return hub.replace(/\/+$/, '');
  } catch { /* not installed from a website */ }
  return process.env.PIGEON_SITE || DEFAULT_SITE;
}

const session = {
  load() { return readJson(path.join(home(), 'session.json'), {}); },
  save(s) {
    fs.mkdirSync(home(), { recursive: true });
    const file = path.join(home(), 'session.json');
    fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
    try { fs.chmodSync(file, 0o600); } catch { /* windows */ }
  },
};

class PigeonError extends Error {
  constructor(msg, status) { super(msg); this.status = status; }
}

class Nest {
  constructor(s = session.load()) {
    this.site = (s.site || site()).replace(/\/+$/, '');
    this.name = s.nest || null;
    this.token = s.token || null;
    this.key = s.key ? C.unb64(s.key) : null;
  }

  get in() { return !!(this.token && this.key); }

  save() {
    const s = session.load();
    session.save({ ...s, site: this.site, nest: this.name, token: this.token, key: this.key ? C.b64(this.key) : undefined });
  }

  async http(what, { method = 'POST', body, raw, auth = true, timeout = 60000 } = {}) {
    const headers = {};
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (raw) headers['content-type'] = 'application/octet-stream';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);
    let res;
    try {
      res = await fetch(`${this.site}/api/${what}`, { method, headers, body: raw || (body !== undefined ? JSON.stringify(body) : undefined), signal: ac.signal });
    } catch (e) {
      const why = e.name === 'AbortError' ? 'it took too long' : (e.cause && (e.cause.code || e.cause.message)) || e.message;
      throw new PigeonError(`Couldn't reach ${this.site.replace(/^https?:\/\//, '')} (${why}). Check your internet connection.`);
    } finally {
      clearTimeout(timer);
    }
    if ((res.headers.get('content-type') || '').includes('octet-stream')) {
      if (!res.ok) throw new PigeonError(`The site answered ${res.status}.`, res.status);
      return Buffer.from(await res.arrayBuffer());
    }
    let j = {};
    try { j = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      if (res.status === 401) { this.token = null; }
      throw new PigeonError(j.error || `The site answered ${res.status}.`, res.status);
    }
    return j;
  }

  // ── accounts ──────────────────────────────────────────────────────────────
  /** Log in, or make the nest if it doesn't exist yet (and the site allows it). Returns 'in' or 'made'. */
  async enter(name, password, { make = 'ask' } = {}) {
    name = String(name || '').toLowerCase().trim();
    const hi = await this.http('hello', { body: { nest: name }, auth: false });
    if (hi.exists) {
      const k = await C.stretch(password, hi.salt);
      const r = await this.http('login', { body: { nest: name, proof: k.proof, device: device() }, auth: false });
      Object.assign(this, { name, token: r.token, key: k.key });
      this.save();
      return 'in';
    }
    if (!hi.canMake) throw new PigeonError(`There's no nest called "${name}" on this site, and it isn't taking new ones.`);
    if (make === false) throw new PigeonError(`There's no nest called "${name}" yet.`);
    if (make === 'ask') return 'new';
    const salt = C.newSalt();
    const k = await C.stretch(password, salt);
    const r = await this.http('signup', { body: { nest: name, salt, proof: k.proof, device: device() }, auth: false });
    Object.assign(this, { name, token: r.token, key: k.key });
    this.save();
    return 'made';
  }

  async leave() {
    try { await this.http('logout', { body: {} }); } catch { /* logged out anyway */ }
    this.token = null;
    this.key = null;
    this.save();
  }

  // ── files ─────────────────────────────────────────────────────────────────
  /** Your files, newest first, with their real names unlocked. */
  async list() {
    const r = await this.http('list', { body: {} });
    const files = [];
    for (const f of r.files) {
      try {
        const key = C.unwrapKey(this.key, f.wrapped);
        files.push({ ...f, fileKey: key, meta: C.openMeta(key, f.meta) });
      } catch {
        files.push({ ...f, fileKey: null, meta: { name: '(locked with a different password)', size: f.size } });
      }
    }
    return { files, used: r.used, quota: r.quota, maxFile: r.maxFile };
  }

  /** Send a file or a folder. onProgress(doneBytes, totalBytes). */
  async send(target, { onProgress = () => {}, name } = {}) {
    let file = path.resolve(target);
    let st = fs.statSync(file);
    let meta = { name: name || path.basename(file), type: mimeOf(file), kind: 'file', from: device(), made: st.mtimeMs };
    let cleanup = null;
    if (st.isDirectory()) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon-'));
      const bundle = path.join(tmp, path.basename(file) + '.tar.gz');
      pack(file, bundle);
      cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
      meta = { ...meta, name: path.basename(file), kind: 'folder', type: 'application/gzip' };
      file = bundle;
      st = fs.statSync(file);
    }
    try {
      meta.size = st.size;
      const chunks = Math.max(1, Math.ceil(st.size / C.CHUNK));
      const fileKey = C.newFileKey();
      const r = await this.http('start', { body: { size: st.size, chunks, meta: C.sealMeta(fileKey, meta), wrapped: C.wrapKey(this.key, fileKey), device: device() } });
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(C.CHUNK);
        for (let n = 0; n < chunks; n++) {
          const got = fs.readSync(fd, buf, 0, C.CHUNK, n * C.CHUNK);
          const box = C.sealChunk(fileKey, n, buf.subarray(0, got));
          await retry(() => this.http(`piece?id=${r.id}&n=${n}`, { method: 'PUT', raw: box, timeout: 180000 }));
          onProgress(Math.min(st.size, (n + 1) * C.CHUNK), st.size);
        }
      } finally {
        fs.closeSync(fd);
      }
      await this.http('finish', { body: { id: r.id } });
      return { id: r.id, meta };
    } finally {
      if (cleanup) cleanup();
    }
  }

  /** Download a file (from list()) into a folder. Returns where it went. */
  async get(f, dir, { onProgress = () => {} } = {}) {
    if (!f.fileKey) throw new PigeonError("That file was locked with a different password, so it can't be opened here.");
    return fetchInto({ chunks: f.chunks, size: f.size, meta: f.meta, key: f.fileKey, piece: (n) => this.http(`piece?id=${f.id}&n=${n}`, { method: 'GET', timeout: 180000 }) }, dir, onProgress);
  }

  async remove(f) { return this.http('delete', { body: { id: f.id } }); }

  /** A link anyone can open for a while: the key rides after the '#', which never reaches the website. */
  async share(f, hours = 24) {
    const r = await this.http('share', { body: { id: f.id, hours } });
    return { url: `${this.site}/s/${r.code}#${C.b64url(f.fileKey)}`, expires: r.expires, code: r.code };
  }
}

/** Open a share link (no nest needed). */
async function fetchShared(link, dir, onProgress = () => {}) {
  const m = /^(https?:\/\/.+)\/s\/([a-z2-9]{8})#([A-Za-z0-9_-]{43})$/.exec(String(link).trim());
  if (!m) throw new PigeonError("That doesn't look like a pigeon link.");
  const nest = new Nest({ site: m[1] });
  const info = await nest.http(`shared/${m[2]}`, { method: 'GET', auth: false });
  const key = C.unb64url(m[3]);
  const meta = C.openMeta(key, info.meta);
  return fetchInto({ chunks: info.chunks, size: info.size, meta, key, piece: (n) => nest.http(`shared/${m[2]}/${n}`, { method: 'GET', auth: false, timeout: 180000 }) }, dir, onProgress);
}

async function fetchInto({ chunks, size, meta, key, piece }, dir, onProgress) {
  fs.mkdirSync(dir, { recursive: true });
  const folder = meta.kind === 'folder';
  const safe = safeName(meta.name) + (folder ? '.tar.gz' : '');
  const tmp = path.join(dir, `.${safe}.pigeon-part`);
  const fd = fs.openSync(tmp, 'w');
  try {
    let done = 0;
    for (let n = 0; n < chunks; n++) {
      const box = await retry(() => piece(n));
      const plain = C.openChunk(key, n, box);
      fs.writeSync(fd, plain);
      done += plain.length;
      onProgress(done, size);
    }
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  if (folder) {
    const where = free(path.join(dir, safeName(meta.name)));
    fs.mkdirSync(where, { recursive: true });
    try { unpack(tmp, where); } finally { fs.rmSync(tmp, { force: true }); }
    return where;
  }
  const where = free(path.join(dir, safe));
  fs.renameSync(tmp, where);
  if (meta.made) try { fs.utimesSync(where, new Date(), new Date(meta.made)); } catch { /* fine */ }
  return where;
}

async function retry(fn, tries = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || (e.status && e.status < 500 && e.status !== 429)) throw e;
      await new Promise((r) => setTimeout(r, 800 * i));
    }
  }
}

/** A file name that's safe on every system (no folders, no odd characters). */
function safeName(name) {
  let n = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '').trim().slice(0, 180);
  if (!n || /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = 'file' + (n ? '-' + n : '');
  return n;
}

/** photo.jpg -> "photo (2).jpg" if photo.jpg is already there. */
function free(p) {
  if (!fs.existsSync(p)) return p;
  const ext = /\.tar\.gz$/i.test(p) ? '.tar.gz' : path.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  for (let i = 2; ; i++) if (!fs.existsSync(`${stem} (${i})${ext}`)) return `${stem} (${i})${ext}`;
}

// Folders: bundled with the system's tar (macOS, Linux and Windows 10+ all have it),
// leaving out the things that are big and easy to get back.
const SKIP = ['node_modules', '.git', '__pycache__', '.venv', 'venv', '.next', '.cache', '.DS_Store', '*.pyc', 'target', '.gradle', '.idea'];

function pack(dir, out) {
  const { spawnSync } = require('child_process');
  const args = ['-czf', out, ...SKIP.map((s) => `--exclude=${s}`), '-C', path.dirname(dir), path.basename(dir)];
  const r = spawnSync('tar', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error || r.status !== 0) throw new PigeonError(`Couldn't bundle that folder: ${r.error ? r.error.message : String(r.stderr).trim()}`);
}

function unpack(file, into) {
  const { spawnSync } = require('child_process');
  // a bundle holds one top folder: drop it, so the files land in `into`
  const r = spawnSync('tar', ['-xzf', file, '-C', into, '--strip-components=1'], { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.error || r.status !== 0) throw new PigeonError(`Couldn't unpack the folder: ${r.error ? r.error.message : String(r.stderr).trim()}`);
}

const TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', svg: 'image/svg+xml',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', zip: 'application/zip', gz: 'application/gzip',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', html: 'text/html', csv: 'text/csv',
  js: 'text/javascript', py: 'text/x-python', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
const mimeOf = (f) => TYPES[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream';

/** Where downloads go: this folder, unless that's your home folder (then Downloads). */
function downloads() {
  const here = process.cwd();
  if (path.resolve(here) !== path.resolve(os.homedir())) return here;
  const d = path.join(os.homedir(), 'Downloads');
  return fs.existsSync(d) ? d : here;
}

module.exports = { Nest, PigeonError, fetchShared, safeName, free, pack, unpack, mimeOf, downloads, home, site, session, device, DEFAULT_SITE };
