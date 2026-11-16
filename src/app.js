'use strict';
// pigeon's screen: your nest, folder by folder.
//
//   [Coo]  pigeon                               dhruv · djp7.pythonanywhere.com
//          3 files · 9 MB of 400 MB  ━━━━──────
//   ───────────────────────────────────────────────────────────────────────────
//   My nest › Projects
//   › ▤    game/                                            folder
//     PNG  phone-photo.png    ★     12 KB   from iPhone        2m ago
//   ───────────────────────────────────────────────────────────────────────────
//   › drop a file here, or type its path
//   enter open/save · l link · p send to device · n folder · ? keys

const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./ansi');
const Th = require('./theme');
const Coo = require('./bird');
const QR = require('./qr');
const { Editor } = require('./editor');
const { Tui, fit, spread, size, ago, bar, copy, open: openFile } = require('./tui');
const { Nest, downloads, session, DEFAULT_SITE, inside, under, pathKey } = require('./nest');
const pkg = require('../package.json');

const TAGS = { image: ['IMG', 'violet'], folder: ['DIR', 'orange'], doc: ['DOC', 'teal'], other: ['', 'dim'] };
function tagOf(meta) {
  if (meta.kind === 'folder') return ['DIR', 'orange'];
  const ext = (path.extname(meta.name || '').slice(1) || '').toUpperCase().slice(0, 4);
  if (/^image\//.test(meta.type || '')) return [ext || 'IMG', 'violet'];
  if (/pdf|text|json|document|csv|markdown/.test(meta.type || '')) return [ext || 'DOC', 'teal'];
  return [ext || 'FILE', 'dim'];
}

/** Drag-and-drop gives paths with quotes or backslash-escaped spaces: turn them back into paths. */
function pathsIn(text) {
  const out = [];
  const re = /'([^']+)'|"([^"]+)"|((?:\\.|[^\s])+)/g;
  let m;
  while ((m = re.exec(text.trim()))) {
    let p = m[1] || m[2] || m[3].replace(/\\(.)/g, '$1');
    if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7));
    if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
    out.push(p);
  }
  return out;
}

class App {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.cfg = session.load();
    Th.use(this.cfg.theme || 'sky');
    this.nest = new Nest();
    this.ed = new Editor();
    this.files = []; // what's shown: folders, then files, in the folder you're in
    this.all = []; // everything in the nest
    this.path = [];
    this.prompt = null; // { label, ed, done } when asking for a name
    this.inboxSeen = new Set();
    this.used = 0;
    this.quota = 0;
    this.sel = 0;
    this.top = 0;
    this.job = null; // { kind: 'send'|'get', name, done, total }
    this.queue = [];
    this.flash = null;
    this.panel = null; // { kind: 'qr'|'catch'|'help', ... }
    this.armed = null; // a delete waiting for its second press
    this.mood = { scene: 'idle', at: Date.now(), until: 0 };
    this.form = this.nest.in ? null : this.newForm();
    this.ui = new Tui({ input, output, paper: Th.t().paper, render: (w, h) => this.frame(w, h) });
    this.ui.on('key', (s, k) => this.onKey(s, k));
    this.ui.on('paste', (t) => { this.target().insert(t.replace(/\n+/g, ' ')); this.dirty(); });
    this.ui.on('mouse', (m) => { if (m.wheel) { this.moveSel(m.wheel); this.dirty(); } });
  }

  newForm() {
    const f = { fields: [['site', 'Website', new Editor()], ['nest', 'Nest name', new Editor()], ['pw', 'Password', new Editor()]], at: 1, making: false, msg: '' };
    f.fields[0][2].set(this.nest.site || DEFAULT_SITE);
    if (this.nest.name) f.fields[1][2].set(this.nest.name);
    return f;
  }

  target() { return this.form ? this.form.fields[this.form.at][2] : this.prompt ? this.prompt.ed : this.ed; }

  run() {
    return new Promise((resolve) => {
      this.done = resolve;
      this.ui.start();
      this.ticker = setInterval(() => { if (this.flash && this.flash.until < Date.now()) this.flash = null; this.dirty(); }, 150);
      this.poller = setInterval(() => { this.refresh(true); this.checkInbox(); }, 8000);
      if (!this.form) { this.refresh(); this.checkInbox(); }
    });
  }

  quit() {
    clearInterval(this.ticker);
    clearInterval(this.poller);
    clearInterval(this.catcher);
    if (this.dash) this.dash.close();
    this.ui.stop();
    if (this.done) this.done();
  }

  dirty() { this.ui.schedule(); }
  say(text, kind = 'teal', ms = 4000) { this.flash = { text, kind, until: Date.now() + ms }; this.dirty(); }
  react(scene, ms = 0) { this.mood = { scene, at: Date.now(), until: ms ? Date.now() + ms : 0 }; }

  async refresh(quiet = false) {
    if (this.form || !this.nest.in) return;
    try {
      const r = await this.nest.list();
      const selKey = this.files[this.sel] && keyOf(this.files[this.sel]);
      this.all = r.files;
      this.used = r.used;
      this.quota = r.quota;
      this.owner = r.owner;
      this.layout();
      const i = this.files.findIndex((f) => keyOf(f) === selKey);
      this.sel = i >= 0 ? i : Math.min(this.sel, Math.max(0, this.files.length - 1));
      this.offline = false;
    } catch (e) {
      if (e.status === 401) { this.form = this.newForm(); this.form.msg = 'Please log in again.'; }
      else if (!quiet) this.say(e.message, 'err', 6000);
      this.offline = true;
    }
    this.dirty();
  }

  /** What's in the folder you're in: its folders first, then its files (newest first). */
  layout() {
    const { dirs, files } = inside(this.all, this.path);
    this.files = dirs.map((d) => ({ dir: true, name: d.name, path: [...this.path, d.name], entry: d.entry, meta: { name: d.name, star: d.entry && d.entry.meta.star } }))
      .concat(files.sort((a, b) => b.made - a.made));
  }

  go(path) { this.path = path; this.sel = 0; this.top = 0; this.layout(); this.dirty(); }

  /** Files other devices sent straight to this computer: save them as they land. */
  async checkInbox() {
    if (this.form || !this.nest.in) return;
    let list = [];
    try { list = await this.nest.inbox(); } catch { return; }
    for (const f of list) {
      if (this.inboxSeen.has(f.id)) continue;
      this.inboxSeen.add(f.id);
      this.queue.push({ kind: 'get', file: f, inbox: true });
    }
    this.pump();
  }

  ask(label, value, done) {
    const ed = new Editor();
    if (value) ed.set(value);
    this.prompt = { label, ed, done };
    this.dirty();
  }

  newFolder() {
    this.ask('New folder name', '', async (name) => {
      name = name.trim().replace(/\//g, '-');
      if (!name) return;
      try { await this.nest.mkdir([...this.path, name], this.all); this.say(`Made ${name}/`, 'ok'); await this.refresh(true); } catch (e) { this.say(e.message, 'err'); }
    });
  }

  rename(f) {
    if (!f || (!f.dir && !f.fileKey)) return;
    this.ask('Rename to', f.meta.name, async (name) => {
      name = name.trim().replace(/\//g, '-');
      if (!name || name === f.meta.name) return;
      try {
        if (!f.dir) await this.nest.relabel([{ file: f, meta: { ...f.meta, name } }]);
        else await this.nest.relabel(rebase(this.all, f.path, [...f.path.slice(0, -1), name]));
        this.say(`Renamed to ${name}.`, 'ok');
        await this.refresh(true);
      } catch (e) { this.say(e.message, 'err'); }
    });
  }

  move(f) {
    if (!f) return;
    this.ask('Move to folder (like Projects/game; empty = My nest)', this.path.join('/'), async (to) => {
      const dest = to.split('/').map((x) => x.trim()).filter(Boolean);
      try {
        if (f.dir && pathKey(dest).startsWith(pathKey(f.path))) throw new Error("A folder can't go inside itself.");
        if (dest.length) await this.nest.mkdir(dest, this.all);
        if (f.dir) await this.nest.relabel(rebase(this.all, f.path, [...dest, f.name]));
        else await this.nest.relabel([{ file: f, meta: { ...f.meta, path: dest } }]);
        this.say(`Moved to ${dest.length ? dest.join(' › ') : 'My nest'}.`, 'ok');
        await this.refresh(true);
      } catch (e) { this.say(e.message, 'err'); }
    });
  }

  async star(f) {
    if (!f) return;
    try {
      let target = f.dir ? f.entry : f;
      if (f.dir && !target) { await this.nest.mkdir(f.path, this.all); await this.refresh(true); target = this.all.find((x) => x.kind === 'dir' && pathKey([...x.meta.path, x.meta.name]) === pathKey(f.path)); }
      if (!target || !target.fileKey) return;
      await this.nest.relabel([{ file: target, meta: { ...target.meta, star: !target.meta.star } }]);
      this.say(target.meta.star ? 'Star removed.' : 'Starred.', 'ok');
      await this.refresh(true);
    } catch (e) { this.say(e.message, 'err'); }
  }

  async devicesPanel(f) {
    if (!f || (f.dir && !under(this.all, f.path).length)) return;
    try {
      const list = (await this.nest.devices()).filter((d) => !d.me);
      if (!list.length) return this.say('No other devices yet: sign in to pigeon on your phone or another computer first.', 'orange', 6000);
      this.panel = { kind: 'devices', list, sel: 0, file: f };
    } catch (e) { this.say(e.message, 'err'); }
    this.dirty();
  }

  async deliver() {
    const p = this.panel;
    const d = p.list[p.sel];
    const files = p.file.dir ? under(this.all, p.file.path).filter((x) => x.kind !== 'dir' && !x.trashed) : [p.file];
    this.panel = null;
    try {
      await this.nest.http('deliver', { body: { ids: files.map((x) => x.id), to: d.did } });
      this.say(`On its way to ${d.name}: it lands there by itself when pigeon is open.`, 'ok', 6000);
      this.react('send', 1600);
    } catch (e) { this.say(e.message, 'err'); }
  }

  async dashboard() {
    try {
      if (!this.dash) this.dash = await require('./dashboard').serve({ saveDir: downloads() });
      else openFile(this.dash.url);
      this.say('Opened your nest in the browser.', 'ok');
    } catch (e) { this.say(e.message, 'err'); }
  }

  // ── doing things ──────────────────────────────────────────────────────────
  send(text) {
    const paths = pathsIn(text);
    const bad = paths.filter((p) => !fs.existsSync(p));
    if (!paths.length) return;
    if (bad.length) return this.say(`Can't find ${bad[0]}`, 'err');
    for (const p of paths) this.queue.push({ kind: 'send', path: p, folder: this.path });
    this.pump();
  }

  get(f) {
    if (!f) return;
    if (f.dir) return this.go(f.path);
    this.queue.push({ kind: 'get', file: f });
    this.pump();
  }

  async pump() {
    if (this.job || !this.queue.length) return;
    const next = this.queue.shift();
    const name = next.kind === 'send' ? path.basename(next.path) : next.file.meta.name;
    this.job = { kind: next.kind, name, done: 0, total: 1 };
    this.react(next.kind);
    const onProgress = (d, t) => { this.job.done = d; this.job.total = t || 1; this.dirty(); };
    try {
      if (next.kind === 'send') {
        await this.nest.send(next.path, { onProgress, folder: next.folder || [] });
        this.say(`Sent ${name} - it's in your nest${next.folder && next.folder.length ? ' (' + next.folder.join(' › ') + ')' : ''}.`, 'ok');
        await this.refresh(true);
      } else {
        const where = await this.nest.get(next.file, downloads(), { onProgress });
        this.lastSaved = where;
        if (next.inbox) await this.nest.got(next.file, !!next.file.meta.drop).catch(() => {});
        const from = next.inbox ? ` from ${(next.file.meta.from || 'another device').replace(/ \(web\)$/, '')}` : '';
        this.say(`Saved ${path.basename(where)}${from} → ${where.replace(os.homedir(), '~')}   (o opens it)`, 'ok', 7000);
      }
      this.react('done', Coo.length('done'));
    } catch (e) {
      this.say(`${name}: ${e.message}`, 'err', 8000);
      this.react('oops', 3000);
    } finally {
      this.job = null;
      this.dirty();
      this.pump();
    }
  }

  async share(f) {
    if (!f || f.dir) return;
    try {
      const s = await this.nest.share(f, 24);
      copy(s.url, this.ui.output);
      this.panel = { kind: 'qr', title: f.meta.name, url: s.url, note: 'Scan with your phone, or paste the link anywhere. It works for 24 hours (link copied).' };
    } catch (e) { this.say(e.message, 'err'); }
  }

  /** Wait for a file from your phone, and fetch it the moment it lands. */
  catch() {
    const known = new Set(this.all.map((f) => f.id));
    this.panel = { kind: 'catch', title: 'Waiting for your phone…', url: this.nest.site, note: 'Scan this with your phone, log in, and send something. It lands here by itself. (esc to stop)', caught: 0 };
    this.react('wait');
    clearInterval(this.catcher);
    this.catcher = setInterval(async () => {
      if (!this.panel || this.panel.kind !== 'catch') { clearInterval(this.catcher); return; }
      await this.refresh(true);
      for (const f of this.all) {
        if (known.has(f.id) || !f.done || f.kind === 'dir' || f.trashed || this.inboxSeen.has(f.id)) continue;
        known.add(f.id);
        this.panel.caught++;
        this.get(f);
      }
    }, 2000);
  }

  async remove(f) {
    if (!f) return;
    const k = keyOf(f);
    if (this.armed !== k) { this.armed = k; this.say(`Press d again to move ${f.meta.name} to the trash`, 'orange', 3000); setTimeout(() => { if (this.armed === k) this.armed = null; }, 3000); return; }
    this.armed = null;
    try {
      const list = f.dir ? under(this.all, f.path) : [f];
      await this.nest.trash(list);
      this.undo = list;
      this.say(`Moved ${f.meta.name} to the trash.  (u undoes it)`, 'teal', 7000);
      await this.refresh(true);
    } catch (e) { this.say(e.message, 'err'); }
  }

  async submitForm() {
    const f = this.form;
    const val = (k) => f.fields.find((x) => x[0] === k)[2].text.trim();
    if (f.at < f.fields.length - 1) { f.at++; return; }
    const site = val('site').replace(/\/+$/, '');
    if (!/^https?:\/\/\S+$/.test(site)) { f.msg = 'The website should start with https://'; f.at = 0; return; }
    if (!/^[a-z0-9][a-z0-9_-]{1,23}$/i.test(val('nest'))) { f.msg = 'A nest name is 2-24 characters: letters, numbers, _ and -'; f.at = 1; return; }
    if (val('pw').length < 6) { f.msg = 'Use a password of at least 6 characters.'; return; }
    if (f.making && f.fields[3][2].text !== f.fields[2][2].text) { f.msg = "The two passwords don't match."; return; }
    f.msg = 'Unlocking…';
    this.dirty();
    try {
      this.nest = new Nest({ site });
      const r = await this.nest.enter(val('nest'), f.fields[2][2].text, { make: f.making ? true : 'ask' });
      if (r === 'new') {
        f.making = true;
        f.fields.push(['pw2', 'Password again', new Editor()]);
        f.at = 3;
        f.msg = `There's no nest called "${val('nest')}" yet. Type the password again to make it.`;
        return this.dirty();
      }
      this.form = null;
      this.say(r === 'made' ? `Made your nest "${this.nest.name}". Use the same name and password on your phone.` : `Welcome back, ${this.nest.name}.`, 'ok', 6000);
      this.refresh();
    } catch (e) {
      f.msg = e.message;
    }
    this.dirty();
  }

  // ── keys ──────────────────────────────────────────────────────────────────
  onKey(s, k) {
    if (k.ctrl && (k.name === 'c' || (k.name === 'd' && !this.target().text))) return this.quit();
    if (this.form) return this.formKey(s, k);
    if (this.prompt) {
      if (k.name === 'escape') this.prompt = null;
      else if (k.name === 'return') { const p = this.prompt; this.prompt = null; p.done(p.ed.text); }
      else edit(this.prompt.ed, s, k);
      return this.dirty();
    }
    if (this.panel && this.panel.kind === 'devices') {
      const p = this.panel;
      if (k.name === 'up') p.sel = Math.max(0, p.sel - 1);
      else if (k.name === 'down') p.sel = Math.min(p.list.length - 1, p.sel + 1);
      else if (k.name === 'return') this.deliver();
      else if (k.name === 'escape' || s === 'q') this.panel = null;
      return this.dirty();
    }
    if (this.panel) {
      if (k.name === 'escape' || k.name === 'return' || s === 'q') { this.panel = null; this.react('idle'); clearInterval(this.catcher); }
      return this.dirty();
    }
    const empty = !this.ed.text;
    const f = this.files[this.sel];
    if (empty && !k.ctrl && !k.meta) {
      switch (s) {
        case 'q': return this.quit();
        case 'l': this.share(f); return this.dirty();
        case 'c': this.catch(); return this.dirty();
        case 'd': this.remove(f); return this.dirty();
        case 'u': if (this.undo) { const list = this.undo; this.undo = null; this.nest.trash(list, true).then(() => { this.say('Put back.', 'ok'); this.refresh(true); }, (e) => this.say(e.message, 'err')); } return;
        case 'n': this.newFolder(); return;
        case 'r': this.rename(f); return;
        case 'm': this.move(f); return;
        case '*': this.star(f); return;
        case 'p': this.devicesPanel(f); return;
        case 'w': this.dashboard(); return;
        case 'o': if (this.lastSaved) openFile(this.lastSaved); else openFile(downloads()); return;
        case 's': this.say('Drop a file or folder onto this window, or type its path and press Enter.', 'teal', 6000); return;
        case 't': { const n = Th.name() === 'sky' ? 'dusk' : 'sky'; Th.use(n); this.cfg = { ...session.load(), theme: n }; session.save(this.cfg); this.ui.setPaper(Th.t().paper); return; }
        case '?': this.panel = { kind: 'help' }; return this.dirty();
        case 'x': this.nest.leave().then(() => { this.form = this.newForm(); this.files = []; this.dirty(); }); return;
        default:
      }
    }
    switch (k.name) {
      case 'return': if (this.ed.text.trim()) { const t = this.ed.text; this.ed.clear(); this.send(t); } else this.get(f); break;
      case 'up': if (empty) this.moveSel(-1); break;
      case 'down': if (empty) this.moveSel(1); break;
      case 'pageup': this.moveSel(-10); break;
      case 'pagedown': this.moveSel(10); break;
      case 'escape': this.ed.clear(); break;
      case 'backspace': if (empty && this.path.length) { this.go(this.path.slice(0, -1)); break; } edit(this.ed, s, k); break;
      case 'left': if (empty && this.path.length) { this.go(this.path.slice(0, -1)); break; } edit(this.ed, s, k); break;
      case 'right': if (empty && f && f.dir) { this.go(f.path); break; } edit(this.ed, s, k); break;
      default: if (k.ctrl && k.name === 'r') { this.refresh(); this.say('Refreshed.'); break; } edit(this.ed, s, k);
    }
    this.dirty();
  }

  formKey(s, k) {
    const f = this.form;
    if (k.name === 'return') { this.submitForm(); return this.dirty(); }
    if (k.name === 'tab' || k.name === 'down') f.at = (f.at + 1) % f.fields.length;
    else if (k.name === 'up' || (k.shift && k.name === 'tab')) f.at = (f.at - 1 + f.fields.length) % f.fields.length;
    else if (k.name === 'escape') return this.quit();
    else edit(f.fields[f.at][2], s, k);
    this.dirty();
  }

  moveSel(step) {
    if (!this.files.length) return;
    this.sel = Math.max(0, Math.min(this.files.length - 1, this.sel + step));
    this.armed = null;
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  frame(W, H) {
    const t = Th.t();
    const lines = [];
    const big = H >= 22 && W >= 60 && !(this.panel && this.panel.kind !== 'help');
    if (this.mood.until && Date.now() > this.mood.until) this.react('idle');
    if (this.job && this.mood.scene !== this.job.kind) this.react(this.job.kind);
    const host = this.nest.site.replace(/^https?:\/\//, '');
    const right = this.nest.in && !this.form ? Th.dim(`${this.nest.name} · ${host}`) : Th.dim(host);
    const count = this.all.filter((x) => !x.trashed && x.done && x.kind !== 'dir').length;
    const used = this.quota ? `${count} file${count === 1 ? '' : 's'} · ${size(this.used)} of ${size(this.quota)}` : '';
    const meter = this.quota ? '  ' + Th.teal(bar(this.used / this.quota, 12, '━', '─').replace(/─+$/, (m) => Th.line(m))) : '';
    const status = this.job
      ? Th[this.job.kind === 'send' ? 'violet' : 'teal'](`${this.job.kind === 'send' ? 'sending' : 'fetching'} ${this.job.name}`) + '  ' + Th.dim(bar(this.job.done / this.job.total, 16, '█', '░')) + Th.dim(`  ${Math.round((100 * this.job.done) / this.job.total)}%`) + (this.queue.length ? Th.faint(`  +${this.queue.length} waiting`) : '')
      : this.offline ? Th.err("can't reach the website right now") : '';
    if (big) {
      const bird = Coo.draw(this.mood.scene, Date.now() - this.mood.at, t.paper.bg);
      const side = ['', A.paint('pigeon', { bold: true }) + Th.faint(`  v${pkg.version}`), Th.dim('files between your devices, locked on the way'), '', used + meter, status, '', ''];
      for (let i = 0; i < Coo.HEIGHT; i++) lines.push(' ' + bird[i] + '  ' + (i === 1 ? spread(side[i], right, W - Coo.WIDTH - 4) : side[i] || ''));
    } else {
      lines.push(' ' + spread(A.paint('pigeon', { bold: true }) + '  ' + Th.dim(used), right, W - 2));
      lines.push(' ' + status);
    }
    lines.push(Th.line('─'.repeat(W)));
    const bodyH = H - lines.length - 3;
    const body = this.form ? this.formLines(W, bodyH) : this.panel ? this.panelLines(W, bodyH) : this.listLines(W, bodyH);
    for (let i = 0; i < bodyH; i++) lines.push(body[i] || '');
    lines.push(Th.line('─'.repeat(W)));
    let cursor = null;
    if (this.form) {
      lines.push(' ' + Th.dim(this.form.msg ? '' : 'tab or ↓ next field · enter continue · esc quit'));
      cursor = this.formCursor;
    } else {
      if (this.prompt) {
        const label = this.prompt.label + ': ';
        const lay = this.prompt.ed.layout(Math.max(10, W - 5 - A.vwidth(label)), 1);
        lines.push(' ' + Th.violet(label, { bold: true }) + lay.lines[0]);
        cursor = { row: lines.length - 1, col: 1 + A.vwidth(label) + lay.col };
      } else {
        const lay = this.ed.layout(W - 5, 1);
        lines.push(' ' + Th.teal('› ', { bold: true }) + (this.ed.text ? lay.lines[0] : Th.faint(`drop files here to send them${this.path.length ? ' into ' + this.path[this.path.length - 1] : ''}, or type a path`)));
        if (!this.panel) cursor = { row: lines.length - 1, col: 3 + lay.col };
      }
    }
    lines.push(this.hint(W));
    return { lines, cursor };
  }

  hint(W) {
    const t = Th.t();
    if (this.flash) return ' ' + A.paint(A.clip(this.flash.text, W - 2), { fg: t[this.flash.kind] || t.teal });
    const f = this.files[this.sel];
    const enter = f && f.dir ? 'enter open' : 'enter save';
    const opts = this.form ? [''] : this.prompt ? ['enter ok · esc cancel'] : this.panel ? [this.panel.kind === 'devices' ? '↑↓ pick · enter send · esc cancel' : 'esc close']
      : [`${enter} · ← back · l link · p send to device · n folder · r rename · m move · d delete · w browser · ? keys`, `${enter} · l link · p send to device · d delete · ? keys · q quit`, `${enter} · ? keys · q quit`];
    for (const o of opts) if (A.vwidth(o) + 2 <= W) return ' ' + Th.dim(o);
    return ' ' + Th.dim(A.clip(opts[opts.length - 1], W - 2));
  }

  listLines(W, h) {
    const out = [];
    const crumb = ['My nest', ...this.path].join(' › ');
    out.push(' ' + A.paint(A.clip(crumb, W - 4), { bold: true }) + (this.path.length ? Th.faint('   ← back') : ''));
    if (!this.files.length) {
      out.push('');
      if (this.path.length) out.push('  ' + Th.dim('This folder is empty. Drop files onto this window to send them here.'));
      else {
        out.push('  ' + A.paint('Your nest is empty.', { bold: true }), '');
        out.push('  ' + Th.dim('Send something: drop a file or folder onto this window, or type its path below.'));
        out.push('  ' + Th.dim('From your phone: press ') + Th.teal('c') + Th.dim(' and scan the code, or open ') + Th.link(this.nest.site));
      }
      return out;
    }
    const rows = h - 1;
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + rows - 1) this.top = this.sel - rows + 2;
    const nameW = Math.max(12, W - 62);
    for (let i = this.top; i < this.files.length && out.length < h; i++) {
      const f = this.files[i];
      const on = i === this.sel;
      const pick = on ? Th.teal(' › ', { bold: true }) : '   ';
      const star = f.meta.star ? A.paint(' ★', { fg: '#f2b33d' }) : '';
      if (f.dir) {
        const chip = A.paint(' ▤    ', { fg: '#ffffff', bg: Th.t().teal, bold: true });
        const n = under(this.all, f.path).filter((x) => x.kind !== 'dir' && !x.trashed).length;
        out.push(pick + chip + '  ' + fit(A.paint(A.clip(f.name + '/', nameW - 2), on ? { bold: true } : {}) + star, nameW) + '  ' + Th.dim(`${n} file${n === 1 ? '' : 's'}`.padStart(8)) + (this.armed === keyOf(f) ? '  ' + Th.err('press d again') : ''));
        continue;
      }
      const [tag, col] = tagOf(f.meta);
      const chip = A.paint(` ${tag.padEnd(4)} `, { fg: '#ffffff', bg: Th.t()[col] || Th.t().dim, bold: true });
      const name = A.paint(A.clip(f.meta.name + (f.meta.kind === 'folder' ? '/' : ''), nameW - 2), on ? { bold: true } : {}) + star;
      const fromWho = Th.dim(A.clip('from ' + (f.meta.from || f.device || '?').replace(/ \(web\)$/, ''), 22).padEnd(22));
      const line = pick + chip + '  ' + fit(name, nameW) + '  ' + Th.dim(size(f.size).padStart(8)) + '  ' + fromWho + '  ' + Th.faint(ago(f.made));
      out.push(this.armed === keyOf(f) ? line + '  ' + Th.err('press d again') : line);
    }
    return out;
  }

  panelLines(W, h) {
    const p = this.panel;
    const out = [''];
    if (p.kind === 'help') {
      const rows = [['enter', 'open a folder, or save a file here (or in Downloads)'], ['← →', 'back out of a folder / into one'], ['l', 'make a link + QR code for it (24 hours)'],
        ['p', 'send it to another device: it lands there by itself'], ['c', 'catch: wait for a file from your phone, and save it the moment it lands'],
        ['n', 'new folder'], ['r', 'rename'], ['m', 'move to another folder'], ['*', 'star'], ['d d', 'move to the trash (u undoes it)'],
        ['o', 'open what you just saved'], ['w', 'open your nest in the browser, already signed in'], ['t', 'light / dark'], ['x', 'log out'], ['q', 'quit'], ['', ''],
        ['drop', 'drag files or folders onto this window to send them into this folder'], ['type', 'or type a path and press enter (folders skip node_modules, .git…)']];
      for (const [k, d] of rows.slice(0, h - 1)) out.push('  ' + Th.teal(k.padEnd(6), { bold: true }) + ' ' + Th.dim(d));
      return out;
    }
    if (p.kind === 'devices') {
      out.push('  ' + A.paint(`Send ${p.file.meta.name} to…`, { bold: true }), '');
      p.list.forEach((d, i) => {
        const live = Date.now() - d.seen < 120000;
        out.push((i === p.sel ? Th.teal(' › ', { bold: true }) : '   ') + A.paint(fit(d.name, 34), i === p.sel ? { bold: true } : {}) + '  ' + (live ? Th.ok('online now') : Th.dim('last seen ' + ago(d.seen))));
      });
      out.push('', '  ' + Th.dim('It lands on that device by itself the next time pigeon (or pigeon in the browser) is open there.'));
      return out;
    }
    let qr = [];
    try { qr = QR.lines(p.url, { quiet: 2, paint: (s, fg, bg) => A.paint(s, { fg, bg }) }); } catch (e) { qr = [Th.err(e.message)]; }
    const textW = W - (qr.length ? A.vwidth(qr[0]) : 0) - 8;
    const urlLines = [];
    for (let i = 0; i < p.url.length; i += Math.max(10, textW)) urlLines.push(Th.link(p.url.slice(i, i + Math.max(10, textW))));
    const text = [A.paint(p.title, { bold: true }), '', ...wrap(p.note, textW).map((l) => Th.dim(l)), '', ...urlLines];
    if (p.kind === 'catch') text.push('', p.caught ? Th.ok(`caught ${p.caught} so far`) : Th.violet('listening…'));
    const fits = qr.length <= h - 1 && textW >= 24;
    if (!fits) return out.concat(['  ' + Th.dim('Make the window bigger to show the QR code.'), '', ...text.map((l) => '  ' + l)]);
    for (let i = 0; i < Math.max(qr.length, text.length); i++) out.push('  ' + (qr[i] || ' '.repeat(A.vwidth(qr[0]))) + '    ' + (text[i] || ''));
    return out;
  }

  formLines(W, h) {
    const f = this.form;
    const out = ['', '  ' + A.paint(f.making ? 'Make your nest' : 'Open your nest', { bold: true }), '  ' + Th.dim('Your nest is where files wait for your other devices. Same name and password on your phone.'), ''];
    this.formCursor = null;
    f.fields.forEach(([key, label, ed], i) => {
      const on = i === f.at;
      const shown = key.startsWith('pw') ? '•'.repeat(ed.text.length) : ed.text;
      out.push('  ' + (on ? Th.teal(label, { bold: true }) : Th.dim(label)));
      out.push('  ' + (on ? Th.teal('› ') : '  ') + A.clip(shown, W - 8));
      if (on) this.formCursor = { row: (this.ui.height >= 22 && W >= 60 ? Coo.HEIGHT + 1 : 3) + out.length - 1, col: 4 + Math.min(A.vwidth(shown.slice(0, ed.cursor)), W - 9) };
      out.push('');
    });
    if (f.msg) out.push('  ' + (/^Unlocking/.test(f.msg) ? Th.violet(f.msg) : Th.orange(f.msg)));
    return out;
  }
}

const keyOf = (f) => (f.dir ? 'd:' + pathKey(f.path) : 'f:' + f.id);

/** New labels for everything in a folder that moves (or is renamed) from `from` to `to`. */
function rebase(all, from, to) {
  return under(all, from).filter((f) => f.fileKey).map((f) => {
    const meta = { ...f.meta };
    if (f.kind === 'dir' && pathKey([...f.meta.path, f.meta.name]) === pathKey(from)) { meta.name = to[to.length - 1]; meta.path = to.slice(0, -1); }
    else meta.path = [...to, ...f.meta.path.slice(from.length)];
    return { file: f, meta };
  });
}

function wrap(text, w) {
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/)) {
    if (line && A.vwidth(line + ' ' + word) > w) { out.push(line); line = word; } else line = line ? line + ' ' + word : word;
  }
  if (line) out.push(line);
  return out;
}

function edit(ed, s, k) {
  if (k.ctrl) {
    if (k.name === 'a') return ed.home();
    if (k.name === 'e') return ed.end();
    if (k.name === 'u') return ed.killToStart();
    if (k.name === 'k') return ed.killToEnd();
    if (k.name === 'w') return ed.deleteWord();
    return;
  }
  switch (k.name) {
    case 'backspace': return ed.backspace();
    case 'delete': return ed.del();
    case 'left': return ed.left();
    case 'right': return ed.right();
    case 'home': return ed.home();
    case 'end': return ed.end();
    default: if (s && !k.meta && s >= ' ') ed.insert(s);
  }
}

module.exports = { App, pathsIn, tagOf };
