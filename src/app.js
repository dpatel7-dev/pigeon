'use strict';
// pigeon's screen: your nest's files in one clean list.
//
//   [Coo]  pigeon                               dhruv · djp7.pythonanywhere.com
//          3 files · 9 MB of 400 MB  ━━━━──────
//   ───────────────────────────────────────────────────────────────────────────
//   › PNG  phone-photo.png         12 KB   from iPhone        2m ago
//     DIR  my-project/            165 KB   from laptop        1h ago
//   ───────────────────────────────────────────────────────────────────────────
//   › drop a file here, or type its path
//   enter save · l link + QR · c catch from phone · d delete · q quit

const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('./ansi');
const Th = require('./theme');
const Coo = require('./bird');
const QR = require('./qr');
const { Editor } = require('./editor');
const { Tui, fit, spread, size, ago, bar, copy, open: openFile } = require('./tui');
const { Nest, downloads, session, DEFAULT_SITE } = require('./nest');
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
    this.files = [];
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
    this.ui.on('mouse', (m) => { if (m.wheel) { this.move(m.wheel); this.dirty(); } });
  }

  newForm() {
    const f = { fields: [['site', 'Website', new Editor()], ['nest', 'Nest name', new Editor()], ['pw', 'Password', new Editor()]], at: 1, making: false, msg: '' };
    f.fields[0][2].set(this.nest.site || DEFAULT_SITE);
    if (this.nest.name) f.fields[1][2].set(this.nest.name);
    return f;
  }

  target() { return this.form ? this.form.fields[this.form.at][2] : this.ed; }

  run() {
    return new Promise((resolve) => {
      this.done = resolve;
      this.ui.start();
      this.ticker = setInterval(() => { if (this.flash && this.flash.until < Date.now()) this.flash = null; this.dirty(); }, 150);
      this.poller = setInterval(() => this.refresh(true), 8000);
      if (!this.form) this.refresh();
    });
  }

  quit() {
    clearInterval(this.ticker);
    clearInterval(this.poller);
    clearInterval(this.catcher);
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
      const selId = this.files[this.sel] && this.files[this.sel].id;
      this.files = r.files.filter((f) => f.done);
      this.used = r.used;
      this.quota = r.quota;
      const i = this.files.findIndex((f) => f.id === selId);
      this.sel = i >= 0 ? i : Math.min(this.sel, Math.max(0, this.files.length - 1));
      this.offline = false;
    } catch (e) {
      if (e.status === 401) { this.form = this.newForm(); this.form.msg = 'Please log in again.'; }
      else if (!quiet) this.say(e.message, 'err', 6000);
      this.offline = true;
    }
    this.dirty();
  }

  // ── doing things ──────────────────────────────────────────────────────────
  send(text) {
    const paths = pathsIn(text);
    const bad = paths.filter((p) => !fs.existsSync(p));
    if (!paths.length) return;
    if (bad.length) return this.say(`Can't find ${bad[0]}`, 'err');
    for (const p of paths) this.queue.push({ kind: 'send', path: p });
    this.pump();
  }

  get(f) {
    if (!f) return;
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
        await this.nest.send(next.path, { onProgress });
        this.say(`Sent ${name} - it's waiting in your nest.`, 'ok');
        await this.refresh(true);
        this.sel = 0;
      } else {
        const where = await this.nest.get(next.file, downloads(), { onProgress });
        this.lastSaved = where;
        this.say(`Saved ${path.basename(where)} → ${where.replace(os.homedir(), '~')}   (o opens it)`, 'ok', 7000);
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
    if (!f) return;
    try {
      const s = await this.nest.share(f, 24);
      copy(s.url, this.ui.output);
      this.panel = { kind: 'qr', title: f.meta.name, url: s.url, note: 'Scan with your phone, or paste the link anywhere. It works for 24 hours (link copied).' };
    } catch (e) { this.say(e.message, 'err'); }
  }

  /** Wait for a file from your phone, and fetch it the moment it lands. */
  catch() {
    const known = new Set(this.files.map((f) => f.id));
    this.panel = { kind: 'catch', title: 'Waiting for your phone…', url: this.nest.site, note: 'Scan this with your phone, log in, and send something. It lands here by itself. (esc to stop)', caught: 0 };
    this.react('wait');
    clearInterval(this.catcher);
    this.catcher = setInterval(async () => {
      if (!this.panel || this.panel.kind !== 'catch') { clearInterval(this.catcher); return; }
      await this.refresh(true);
      for (const f of this.files) {
        if (known.has(f.id)) continue;
        known.add(f.id);
        this.panel.caught++;
        this.get(f);
      }
    }, 2000);
  }

  async remove(f) {
    if (!f) return;
    if (this.armed !== f.id) { this.armed = f.id; this.say(`Press d again to delete ${f.meta.name}`, 'orange', 3000); setTimeout(() => { if (this.armed === f.id) this.armed = null; }, 3000); return; }
    this.armed = null;
    try {
      await this.nest.remove(f);
      this.say(`Deleted ${f.meta.name}.`);
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
        case 'r': this.refresh(); this.say('Refreshed.'); return;
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
      case 'up': if (empty) this.move(-1); break;
      case 'down': if (empty) this.move(1); break;
      case 'pageup': this.move(-10); break;
      case 'pagedown': this.move(10); break;
      case 'escape': this.ed.clear(); break;
      default: edit(this.ed, s, k);
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

  move(step) {
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
    const used = this.quota ? `${this.files.length} file${this.files.length === 1 ? '' : 's'} · ${size(this.used)} of ${size(this.quota)}` : '';
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
      const lay = this.ed.layout(W - 5, 1);
      lines.push(' ' + Th.teal('› ', { bold: true }) + (this.ed.text ? lay.lines[0] : Th.faint('drop a file or folder here, or type its path (enter sends)')));
      if (!this.panel) cursor = { row: lines.length - 1, col: 3 + lay.col };
    }
    lines.push(this.hint(W));
    return { lines, cursor };
  }

  hint(W) {
    const t = Th.t();
    if (this.flash) return ' ' + A.paint(A.clip(this.flash.text, W - 2), { fg: t[this.flash.kind] || t.teal });
    const opts = this.form ? [''] : this.panel ? ['esc close']
      : ['enter save · l link + QR · c catch from phone · d delete · o open · t colours · ? keys · q quit', 'enter save · l link · c catch · d delete · ? keys · q quit', 'enter save · ? keys · q quit'];
    for (const o of opts) if (A.vwidth(o) + 2 <= W) return ' ' + Th.dim(o);
    return ' ' + Th.dim(A.clip(opts[opts.length - 1], W - 2));
  }

  listLines(W, h) {
    const out = [];
    if (!this.files.length) {
      out.push('', '  ' + A.paint('Your nest is empty.', { bold: true }), '');
      out.push('  ' + Th.dim('Send something: drop a file or folder onto this window, or type its path below.'));
      out.push('  ' + Th.dim('From your phone: press ') + Th.teal('c') + Th.dim(' and scan the code, or open ') + Th.link(this.nest.site));
      return out;
    }
    out.push('');
    if (this.sel < this.top) this.top = this.sel;
    if (this.sel >= this.top + h - 1) this.top = this.sel - h + 2;
    const nameW = Math.max(12, W - 62);
    for (let i = this.top; i < this.files.length && out.length < h; i++) {
      const f = this.files[i];
      const on = i === this.sel;
      const [tag, col] = tagOf(f.meta);
      const chip = A.paint(` ${tag.padEnd(4)} `, { fg: '#ffffff', bg: Th.t()[col] || Th.t().dim, bold: true });
      const name = A.paint(A.clip(f.meta.name + (f.meta.kind === 'folder' ? '/' : ''), nameW), on ? { bold: true } : {});
      const fromWho = Th.dim(A.clip('from ' + (f.meta.from || f.device || '?').replace(/ \(web\)$/, ''), 22).padEnd(22));
      const line = (on ? Th.teal(' › ', { bold: true }) : '   ') + chip + '  ' + fit(name, nameW) + '  ' + Th.dim(size(f.size).padStart(8)) + '  ' + fromWho + '  ' + Th.faint(ago(f.made));
      out.push(this.armed === f.id ? line + '  ' + Th.err('press d again to delete') : line);
    }
    return out;
  }

  panelLines(W, h) {
    const p = this.panel;
    const out = [''];
    if (p.kind === 'help') {
      const rows = [['enter', 'save the highlighted file here (or in Downloads)'], ['↑ ↓', 'pick a file'], ['l', 'make a link + QR code for it (24 hours)'], ['c', 'catch: wait for a file from your phone, and save it the moment it lands'],
        ['d d', 'delete it'], ['o', 'open what you just saved'], ['r', 'refresh'], ['t', 'light / dark'], ['x', 'log out'], ['q', 'quit'], ['', ''], ['drop', 'drag a file or folder onto this window to send it'], ['type', 'or type a path and press enter (folders skip node_modules, .git…)']];
      for (const [k, d] of rows) out.push('  ' + Th.teal(k.padEnd(6), { bold: true }) + ' ' + Th.dim(d));
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
