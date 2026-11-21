'use strict';
// Your nest: your drive on a pigeon website, and everything that moves in and
// out of it. Sending locks a file piece by piece and uploads it; getting
// downloads the pieces and unlocks them. Every name, folder and star lives in
// a file's locked label ("meta"), so the website never learns them.
//
// pigeon 3 adds, all from here:
//   - sealed requests (wire.js): the website sees one locked blob per request
//   - squeezing: pieces are deflated before they're locked, when that helps
//   - no doubles: a file whose bytes are already in your nest isn't sent again
//   - barns: big buckets (Backblaze B2, Cloudflare R2) the pieces go straight to
//   - Rewind: sending a file with the same name to the same folder keeps the old one as a version
//   - homing: send to one device, or all of them, with receipts when it lands
//   - drop boxes: a link anyone can send you files through, locked for you alone

const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./crypto');
const { Wire } = require('./wire');

const home = () => process.env.PIGEON_HOME || path.join(os.homedir(), '.pigeon');
const DEFAULT_SITE = 'https://djp7.pythonanywhere.com/pigeon';
const PAR = 3; // pieces in flight at once, each way
const deviceName = () => {
  const s = readJson(path.join(home(), 'session.json'), {});
  if (s.deviceName) return s.deviceName;
  return `${os.hostname().replace(/\.local$/, '').slice(0, 40)} (${{ darwin: 'Mac', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform})`;
};
const newDid = () => require('crypto').randomBytes(8).toString('hex');
/** "Projects/game" for a folder path like ['Projects', 'game']. */
const pathKey = (p) => (Array.isArray(p) ? p : []).join('/');

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

/** One request at a time to the site's plain address (GET /api): its version and its sealing key. */
async function siteInfo(base) {
  let res;
  try {
    res = await fetch(`${base}/api`, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
  } catch (e) {
    const why = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'it took too long' : (e.cause && (e.cause.code || e.cause.message)) || e.message;
    throw new PigeonError(`Couldn't reach ${base.replace(/^https?:\/\//, '')} (${why}). Check your internet connection.`);
  }
  let j = {};
  try { j = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || j.name !== 'pigeon') throw new PigeonError(`${base.replace(/^https?:\/\//, '')} doesn't look like a pigeon site.`, res.status);
  return j;
}

class Nest {
  constructor(s = session.load()) {
    this.site = (s.site || site()).replace(/\/+$/, '');
    this.name = s.nest || null;
    this.token = s.token || null;
    this.key = s.key ? C.unb64(s.key) : null;
    this.did = /^[a-f0-9]{16}$/.test(s.did || '') ? s.did : newDid();
    this.wire = null;
    this.plain = false; // an older site that doesn't take sealed requests yet
    this._boxes = null;
  }

  get in() { return !!(this.token && this.key); }

  save() {
    const s = session.load();
    session.save({ ...s, site: this.site, nest: this.name, token: this.token, key: this.key ? C.b64(this.key) : undefined, did: this.did });
  }

  /** The sealed line to the site, set up once: its key is remembered the first time and checked after. */
  async connect() {
    if (this.wire || this.plain) return this.wire;
    const info = await siteInfo(this.site);
    if (!info.wire) { this.plain = true; return null; }
    const s = session.load();
    const pins = s.pins || {};
    if (pins[this.site] && pins[this.site] !== info.wire) {
      throw new PigeonError(`${this.site.replace(/^https?:\/\//, '')} answered with a different key than before, so pigeon stopped (someone could be pretending to be it). If its owner reset or moved the site, run: pigeon site ${this.site} --trust`);
    }
    if (!pins[this.site]) session.save({ ...s, pins: { ...pins, [this.site]: info.wire } });
    this.wireKey = info.wire;
    this.wire = new Wire({ url: `${this.site}/api/w`, serverKey: info.wire });
    return this.wire;
  }

  /**
   * Ask the site something. what: an action ('list', 'start', ...). body: its message.
   * raw: bytes to send along (a piece). wantRaw: return { result, raw } instead of the result.
   */
  async http(what, { body, raw, auth = true, timeout = 60000, wantRaw = false } = {}) {
    await this.connect();
    if (this.plain) return this.plainHttp(what, { body, raw, auth, timeout, wantRaw });
    try {
      const r = await this.wire.call(what, body || {}, { token: auth ? this.token : undefined, raw, timeout });
      return wantRaw ? r : r.result;
    } catch (e) {
      if (e.status === 401 && auth) this.token = null;
      throw new PigeonError(e.message, e.status);
    }
  }

  /** The plain API of pigeon 1 and 2, for a site that hasn't been updated yet. */
  async plainHttp(what, { body, raw, auth, timeout, wantRaw }) {
    let url = `${this.site}/api/${what}`, method = 'POST', send;
    if (what === 'piece_put') { url = `${this.site}/api/piece?id=${body.id}&n=${body.n}`; method = 'PUT'; send = raw; }
    else if (what === 'piece_get') { url = `${this.site}/api/piece?id=${body.id}&n=${body.n}`; method = 'GET'; }
    else if (what === 'shared') { url = `${this.site}/api/shared/${body.code}`; method = 'GET'; }
    else if (what === 'shared_piece') { url = `${this.site}/api/shared/${body.code}/${body.n}`; method = 'GET'; }
    else send = JSON.stringify(body || {});
    const headers = {};
    if (auth && this.token) headers.authorization = `Bearer ${this.token}`;
    if (method === 'POST') headers['content-type'] = 'application/json';
    if (method === 'PUT') headers['content-type'] = 'application/octet-stream';
    let res;
    try { res = await fetch(url, { method, headers, body: send, signal: AbortSignal.timeout(timeout) }); } catch (e) {
      throw new PigeonError(`Couldn't reach ${this.site.replace(/^https?:\/\//, '')} (${e.name === 'TimeoutError' ? 'it took too long' : (e.cause && e.cause.code) || e.message}).`);
    }
    if ((res.headers.get('content-type') || '').includes('octet-stream')) {
      if (!res.ok) throw new PigeonError(`The site answered ${res.status}.`, res.status);
      const b = Buffer.from(await res.arrayBuffer());
      return wantRaw ? { result: {}, raw: b } : b;
    }
    let j = {};
    try { j = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) { if (res.status === 401) this.token = null; throw new PigeonError(j.error || `The site answered ${res.status}.`, res.status); }
    return wantRaw ? { result: j, raw: Buffer.alloc(0) } : j;
  }

  label(text) { return this.key ? C.sealLabel(this.key, text) : text; }
  unlabel(s) { return this.key ? C.openLabel(this.key, s) : s; }

  // ── accounts ──────────────────────────────────────────────────────────────
  /** Log in, or make the nest if it doesn't exist yet. Returns 'in', 'made', or 'new' (make: 'ask'). */
  async enter(name, password, { make = 'ask' } = {}) {
    name = String(name || '').toLowerCase().trim();
    const hi = await this.http('hello', { body: { nest: name }, auth: false });
    if (hi.exists) {
      const k = await C.stretch(password, hi.salt);
      const r = await this.http('login', { body: { nest: name, proof: k.proof, device: this.plain ? deviceName() : C.sealLabel(k.key, deviceName()), did: this.did }, auth: false });
      Object.assign(this, { name, token: r.token, key: k.key, did: r.did || this.did });
      this.save();
      return 'in';
    }
    if (!hi.canMake) throw new PigeonError(`There's no nest called "${name}" here, and this site isn't taking new nests right now.`);
    if (make === false) throw new PigeonError(`There's no nest called "${name}" yet.`);
    if (make === 'ask') return 'new';
    const salt = C.newSalt();
    const k = await C.stretch(password, salt);
    const r = await this.http('signup', { body: { nest: name, salt, proof: k.proof, device: this.plain ? deviceName() : C.sealLabel(k.key, deviceName()), did: this.did }, auth: false });
    Object.assign(this, { name, token: r.token, key: k.key, did: r.did || this.did });
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
  /** Everything in your nest (folders, files, trash), newest first, labels unlocked. Drop-box arrivals are taken in on the way. */
  async list() {
    const r = await this.http('list', { body: {} });
    let files = r.files.map((f) => this.unlock(f));
    if (files.some((f) => f.box && !f.fileKey && f.done)) files = await this.adopt(files);
    if (r.chores) this.chores().catch(() => {});
    return { files, used: r.used, quota: r.quota, maxFile: r.maxFile, me: r.me, owner: r.owner, signups: r.signups, siteUsed: r.siteUsed, siteQuota: r.siteQuota };
  }

  unlock(f) {
    try {
      const key = C.unwrapKey(this.key, f.wrapped);
      const meta = C.openMeta(key, f.meta);
      if (!Array.isArray(meta.path)) meta.path = [];
      if (f.kind === 'bundle' && !meta.kind) meta.kind = 'folder';
      return { ...f, device: this.unlabel(f.device), fileKey: key, meta };
    } catch {
      if (f.box) return { ...f, sealedMeta: f.meta, fileKey: null, meta: { name: '(just arrived in a drop box)', size: f.size, path: ['Drop boxes'] } };
      return { ...f, fileKey: null, meta: { name: '(locked with a different password)', size: f.size, path: [] } };
    }
  }

  /** Files people sent to your drop boxes: unlock them with the box's key, then lock them with yours like any other. */
  async adopt(files) {
    const boxes = await this.boxes().catch(() => []);
    const byCode = new Map(boxes.map((b) => [b.code, b]));
    const items = [];
    const out = files.map((f) => {
      if (!(f.box && !f.fileKey && f.done)) return f;
      const b = byCode.get(f.box);
      if (!b) return f;
      try {
        const fk = C.dropUnwrap(this.key, b, f.wrapped);
        const theirs = C.openMeta(fk, f.sealedMeta);
        const meta = { ...theirs, name: String(theirs.name || 'file').slice(0, 200), path: ['Drop boxes', b.title], from: `${String(theirs.from || 'someone').slice(0, 60)} (drop box)`, box: b.title };
        items.push({ id: f.id, wrapped: C.wrapKey(this.key, fk), meta: C.sealMeta(fk, meta) });
        return { ...f, fileKey: fk, meta, adopted: true };
      } catch { return f; }
    });
    if (items.length) await this.http('adopt', { body: { items } });
    return out;
  }

  /** Delete leftover pieces in storage barns (a few each time; any device can do it). */
  async chores() {
    if (this._choring) return;
    this._choring = true;
    try {
      const { chores } = await this.http('chores', { body: {} });
      const done = [];
      for (const c of chores) {
        try { const res = await fetch(c.url, { method: 'DELETE', signal: AbortSignal.timeout(20000) }); if (res.ok || res.status === 404) done.push(c.id); } catch { /* next time */ }
      }
      if (done.length) await this.http('chores_done', { body: { ids: done } });
    } finally { this._choring = false; }
  }

  /** Send one locked piece: to the website, or straight to a storage barn. */
  async putPiece(r, n, box, ticket) {
    const prefix = ticket ? 'box_' : '';
    const id = { id: r.id, ...(ticket ? { ticket } : {}) };
    if (!r.barn) {
      if (ticket) return this.http('box_piece', { body: { ...id, n }, raw: box, auth: false, timeout: 180000 });
      return this.http('piece_put', { body: { id: r.id, n }, raw: box, timeout: 180000 });
    }
    const w = await this.http(prefix ? 'box_where' : 'where', { body: { ...id, op: 'put', n, len: box.length }, auth: !ticket });
    let res;
    try { res = await fetch(w.url, { method: 'PUT', body: box, signal: AbortSignal.timeout(180000) }); } catch (e) {
      throw new PigeonError(`Couldn't reach the storage barn (${(e.cause && e.cause.code) || e.message}).`, 502);
    }
    if (!res.ok) throw new PigeonError(`The storage barn said no (${res.status}). The site's owner may need to check it: pigeon barn ls`, res.status >= 500 ? 502 : 400);
  }

  /** The pieces of a file, one function per piece number. */
  async pieceGetter(f) {
    if (f.barn) {
      const { urls } = f.urls ? f : await this.http('where_get', { body: { id: f.id } });
      return (n) => fetchBytes(urls[n]);
    }
    return async (n) => (await this.http('piece_get', { body: { id: f.id, n }, timeout: 180000, wantRaw: true })).raw;
  }

  /**
   * Send a file, or a folder as one bundle. folder: where it goes in your nest
   * (['Projects']). to: a device id - it's delivered there by itself.
   * replaces: a file in your nest this is a new version of (Rewind keeps the old one).
   */
  async send(target, { onProgress = () => {}, name, folder = [], to, drop = false, replaces, hours, open, clip, dedupe = true } = {}) {
    let file = path.resolve(target);
    let st = fs.statSync(file);
    let meta = { name: name || path.basename(file), type: mimeOf(file), kind: 'file', from: deviceName(), made: st.mtimeMs, path: folder };
    let cleanup = null;
    if (st.isDirectory()) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon-'));
      const bundle = path.join(tmp, path.basename(file) + '.tar.gz');
      pack(file, bundle);
      cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
      meta = { ...meta, name: name || path.basename(file), kind: 'folder', type: 'application/gzip' };
      file = bundle;
      st = fs.statSync(file);
    }
    if (to) meta.drop = !!drop;
    if (open) meta.open = true;
    if (clip) { meta.clip = true; meta.type = 'text/plain'; }
    try {
      meta.size = st.size;
      await this.connect();
      if (!this.plain) meta.z = 1;
      const chunks = Math.max(1, Math.ceil(st.size / C.CHUNK));
      const common = { device: this.plain ? deviceName() : this.label(deviceName()), to: to || undefined, drop: to ? !!drop : undefined, hours, replaces };
      const fp = dedupe && !this.plain ? C.printOf(this.key, file, st.size) : undefined;
      const fileKey = C.newFileKey();
      const r = await this.http('start', { body: { ...common, size: st.size, chunks, meta: C.sealMeta(fileKey, meta), wrapped: C.wrapKey(this.key, fileKey), print: fp, barns: true } });
      if (r.same) { // these exact bytes are already in your nest: a new entry for them, nothing to upload
        const fk = C.unwrapKey(this.key, r.same.wrapped);
        const c = await this.http('start', { body: { ...common, copy: r.same.id, meta: C.sealMeta(fk, meta) } });
        onProgress(st.size, st.size);
        return { id: c.id, meta, copied: true };
      }
      return await this.upload(file, st, meta, chunks, { ...r, fileKey }, onProgress);
    } finally {
      if (cleanup) cleanup();
    }
  }

  async upload(file, st, meta, chunks, r, onProgress) {
    const { fileKey } = r;
    const squeeze = !this.plain && C.worthSqueezing(meta.name) && meta.type !== 'application/gzip';
    const fd = fs.openSync(file, 'r');
    try {
      let sent = 0;
      const flying = new Set();
      for (let n = 0; n < chunks; n++) {
        const buf = Buffer.alloc(Math.min(C.CHUNK, st.size - n * C.CHUNK));
        fs.readSync(fd, buf, 0, buf.length, n * C.CHUNK);
        const box = this.plain ? C.sealChunk(fileKey, n, buf) : C.sealPiece(fileKey, n, buf, squeeze);
        const job = retry(() => this.putPiece(r, n, box)).then(() => { sent += buf.length; onProgress(sent, st.size); });
        flying.add(job);
        job.then(() => flying.delete(job), () => {});
        if (flying.size >= PAR) await Promise.race(flying);
      }
      await Promise.all(flying);
      if (!st.size) onProgress(0, 0);
    } catch (e) {
      this.http('delete', { body: { ids: [r.id] } }).catch(() => {});
      throw e;
    } finally {
      fs.closeSync(fd);
    }
    await this.http('finish', { body: { id: r.id } });
    return { id: r.id, meta };
  }

  /** A bit of text (a link, a code, a note) for another device: it lands on that device's clipboard. */
  async sendText(text, opts = {}) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon-'));
    const first = String(text).trim().split('\n')[0].replace(/[\\/:*?"<>|]/g, ' ').slice(0, 40).trim() || 'text';
    const f = path.join(tmp, `${first}.txt`);
    fs.writeFileSync(f, String(text));
    try { return await this.send(f, { ...opts, clip: true, dedupe: false, folder: opts.folder || ['Clips'] }); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  /** Make a folder in your nest (and any missing folders above it). */
  async mkdir(folder, known = null) {
    const all = known || (await this.list()).files;
    const have = new Set(all.filter((f) => f.kind === 'dir' && !f.trashed).map((f) => pathKey([...f.meta.path, f.meta.name])));
    for (let i = 1; i <= folder.length; i++) {
      const p = folder.slice(0, i);
      if (have.has(pathKey(p))) continue;
      const fileKey = C.newFileKey();
      const meta = { name: p[p.length - 1], kind: 'dir', path: p.slice(0, -1), from: deviceName(), made: Date.now() };
      await this.http('start', { body: { dir: true, meta: C.sealMeta(fileKey, meta), wrapped: C.wrapKey(this.key, fileKey), device: this.plain ? deviceName() : this.label(deviceName()) } });
      have.add(pathKey(p));
    }
  }

  /** Change labels (rename, move, star): [{ file, meta }] with the new meta. */
  async relabel(changes) {
    if (!changes.length) return;
    const items = changes.map(({ file, meta }) => ({ id: file.id, meta: C.sealMeta(file.fileKey, meta) }));
    for (let i = 0; i < items.length; i += 500) await this.http('meta', { body: { items: items.slice(i, i + 500) } });
  }

  async trash(files, restore = false) { return this.http('trash', { body: { ids: files.map((f) => f.id), restore } }); }

  /** Download a file (from list()) into a folder. Returns where it went. */
  async get(f, dir, { onProgress = () => {}, name } = {}) {
    if (!f.fileKey) throw new PigeonError("That file was locked with a different password, so it can't be opened here.");
    return fetchInto({ chunks: f.chunks, size: f.size, meta: name ? { ...f.meta, name } : f.meta, key: f.fileKey, piece: await this.pieceGetter(f) }, dir, onProgress);
  }

  /** A file's bytes in memory (for small things: diffs, clips). */
  async bytes(f) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon-'));
    try { return fs.readFileSync(await this.get(f, tmp)); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  /** Delete for good (skips the trash). */
  async remove(f) { return this.http('delete', { body: { ids: (Array.isArray(f) ? f : [f]).map((x) => x.id) } }); }

  /** A link anyone can open for a while: the key rides after the '#', which never reaches the website. */
  async share(f, hours = 24) {
    const r = await this.http('share', { body: { id: f.id, hours } });
    return { url: `${this.site}/s/${r.code}#${C.b64url(f.fileKey)}`, expires: r.expires, code: r.code };
  }

  // ── Rewind ────────────────────────────────────────────────────────────────
  /** Every kept version of a file, newest first (the current one is first). */
  async versions(f) {
    const r = await this.http('versions', { body: { id: f.id } });
    return r.versions.map((v) => this.unlock(v));
  }

  /** Bring back an old version: it becomes the newest (the one it replaces is kept too). */
  async restore(version, current) {
    const meta = { ...version.meta, name: current.meta.name, path: current.meta.path, star: current.meta.star, made: Date.now(), from: deviceName() };
    return this.http('start', { body: { copy: version.id, replaces: current.id, meta: C.sealMeta(version.fileKey, meta), device: this.label(deviceName()) } });
  }

  // ── devices ───────────────────────────────────────────────────────────────
  async devices() { return (await this.http('devices', { body: {} })).devices.map((d) => ({ ...d, name: this.unlabel(d.name) })); }
  async forget(did) { return this.http('forget', { body: { did } }); }
  async nameDevice(name) {
    await this.http('name', { body: { name: this.plain ? name : this.label(name) } });
    session.save({ ...session.load(), deviceName: name });
  }
  /** Send files already in your nest to one device, several, or 'all'. */
  async deliver(files, to, { hours } = {}) { return this.http('deliver', { body: { ids: files.map((x) => x.id), to, hours } }); }
  /** Files other devices sent straight to this one. */
  async inbox() { return (await this.http('inbox', { body: {} })).files.map((f) => this.unlock(f)); }
  async got(f, drop = false) { return this.http('got', { body: { id: f.id, drop } }); }
  /** Things you sent to devices lately, and whether they landed. */
  async sent({ since = 0, all = false } = {}) {
    const r = await this.http('sent', { body: { since, all } });
    return r.sent.map((s) => {
      let meta = { name: '(a file)' };
      try { meta = C.openMeta(C.unwrapKey(this.key, s.wrapped), s.meta); } catch { /* another password */ }
      return { ...s, meta };
    });
  }

  // ── drop boxes ────────────────────────────────────────────────────────────
  async boxes() {
    const r = await this.http('boxes', { body: {} });
    this._boxes = r.boxes;
    return r.boxes.map((b) => ({ ...b, url: `${this.site}/d/${b.code}` }));
  }
  async newBox(title, { days = 14, mb = 200, note = '' } = {}) {
    const k = C.newBox(this.key);
    const r = await this.http('boxes', { body: { do: 'new', title, note, days, mb, ...k } });
    const b = r.boxes[0];
    return { ...b, url: `${this.site}/d/${b.code}` };
  }
  async boxDo(code, what) { return (await this.http('boxes', { body: { do: what, code } })).boxes; }
}

/** Send files into someone's drop box (no nest needed). */
async function dropInto(link, files, { name = '', note = '', onProgress = () => {} } = {}) {
  const m = /^(https?:\/\/.+)\/d\/([a-z2-9]{10})\/?$/.exec(String(link).trim());
  if (!m) throw new PigeonError("That doesn't look like a pigeon drop box link (it ends in /d/ and 10 letters).");
  const nest = new Nest({ site: m[1] });
  await nest.connect();
  if (nest.plain) throw new PigeonError('That pigeon site is too old for drop boxes.');
  const info = await nest.http('box_info', { body: { code: m[2] }, auth: false });
  const out = [];
  for (const target of files) {
    const file = path.resolve(target);
    const st = fs.statSync(file);
    if (!st.isFile()) throw new PigeonError(`${path.basename(file)} is a folder: send the files inside it, or zip it first.`);
    const fileKey = C.newFileKey();
    const meta = { name: path.basename(file), type: mimeOf(file), kind: 'file', from: String(name || 'someone').slice(0, 60), note: String(note || '').slice(0, 500), made: st.mtimeMs, size: st.size, path: [], z: 1 };
    const chunks = Math.max(1, Math.ceil(st.size / C.CHUNK));
    const r = await nest.http('box_start', { body: { code: m[2], size: st.size, chunks, meta: C.sealMeta(fileKey, meta), wrapped: C.dropWrap(info.pub, fileKey), barns: true }, auth: false });
    const fd = fs.openSync(file, 'r');
    try {
      let sent = 0;
      for (let n = 0; n < chunks; n++) {
        const buf = Buffer.alloc(Math.min(C.CHUNK, st.size - n * C.CHUNK));
        fs.readSync(fd, buf, 0, buf.length, n * C.CHUNK);
        await retry(() => nest.putPiece(r, n, C.sealPiece(fileKey, n, buf, C.worthSqueezing(meta.name)), r.ticket));
        sent += buf.length;
        onProgress(path.basename(file), sent, st.size);
      }
      if (!st.size) onProgress(path.basename(file), 0, 0);
    } finally { fs.closeSync(fd); }
    await nest.http('box_finish', { body: { id: r.id, ticket: r.ticket }, auth: false });
    out.push(meta.name);
  }
  return { title: info.title, sent: out };
}

/** Open a share link (no nest needed). */
async function fetchShared(link, dir, onProgress = () => {}) {
  const m = /^(https?:\/\/.+)\/s\/([a-z2-9]{8})#([A-Za-z0-9_-]{43})$/.exec(String(link).trim());
  if (!m) throw new PigeonError("That doesn't look like a pigeon link.");
  const nest = new Nest({ site: m[1] });
  const info = await nest.http('shared', { body: { code: m[2] }, auth: false });
  const key = C.unb64url(m[3]);
  const meta = C.openMeta(key, info.meta);
  const piece = info.urls ? (n) => fetchBytes(info.urls[n]) : async (n) => (await nest.http('shared_piece', { body: { code: m[2], n }, auth: false, timeout: 180000, wantRaw: true })).raw;
  return fetchInto({ chunks: info.chunks, size: info.size, meta, key, piece }, dir, onProgress);
}

async function fetchBytes(url) {
  let res;
  try { res = await fetch(url, { signal: AbortSignal.timeout(180000) }); } catch (e) {
    const err = new PigeonError(`Couldn't reach the storage barn (${(e.cause && e.cause.code) || e.message}).`); err.status = 502; throw err;
  }
  if (!res.ok) throw new PigeonError(`The storage barn answered ${res.status}.`, res.status >= 500 ? 502 : 404);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchInto({ chunks, size, meta, key, piece }, dir, onProgress) {
  fs.mkdirSync(dir, { recursive: true });
  const folder = meta.kind === 'folder';
  const safe = safeName(meta.name) + (folder ? '.tar.gz' : '');
  const tmp = path.join(dir, `.${safe}.pigeon-part`);
  const fd = fs.openSync(tmp, 'w');
  try {
    let done = 0;
    const ahead = [];
    const want = (n) => { if (n < chunks) { ahead[n] = retry(() => piece(n)); ahead[n].catch(() => {}); } };
    for (let n = 0; n < Math.min(PAR, chunks); n++) want(n);
    for (let n = 0; n < chunks; n++) {
      const box = await ahead[n];
      ahead[n] = null;
      want(n + PAR);
      const plain = meta.z ? C.openPiece(key, n, box) : C.openChunk(key, n, box);
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

module.exports = {
  Nest, PigeonError, fetchShared, dropInto, safeName, free, pack, unpack, mimeOf, downloads, home, site, session, device: deviceName, DEFAULT_SITE,
  inside, under, pathKey, SKIP, siteInfo,
};

/** The folders and files directly inside `folder`, with folders that only exist because files are in them. */
function inside(files, folder = []) {
  const key = pathKey(folder);
  const dirs = new Map();
  const here = [];
  for (const f of files) {
    if (f.trashed || !f.done) continue;
    const p = pathKey(f.meta.path);
    if (f.kind === 'dir') {
      if (p === key) dirs.set(f.meta.name, dirs.get(f.meta.name) || f);
      continue;
    }
    if (p === key) here.push(f);
    else if (key === '' || p.startsWith(key + '/')) {
      const next = f.meta.path[folder.length];
      if (next && !dirs.has(next)) dirs.set(next, null);
    }
  }
  for (const f of files) { // folders whose only contents are folders
    if (f.trashed || f.kind !== 'dir') continue;
    const p = f.meta.path;
    if (p.length > folder.length && pathKey(p.slice(0, folder.length)) === key && !dirs.has(p[folder.length])) dirs.set(p[folder.length], null);
  }
  return { dirs: [...dirs.entries()].map(([name, entry]) => ({ name, entry })).sort((a, b) => a.name.localeCompare(b.name)), files: here };
}

/** Everything at or below a folder (to move, trash or delete it). */
function under(files, folder) {
  const key = pathKey(folder);
  return files.filter((f) => {
    const own = pathKey([...f.meta.path, f.meta.name]);
    const p = pathKey(f.meta.path);
    return (f.kind === 'dir' && own === key) || p === key || p.startsWith(key + '/');
  });
}
