'use strict';
// `pigeon` and its sub-commands.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const A = require('./ansi');
const Th = require('./theme');
const QR = require('./qr');
const { Nest, fetchShared, downloads, session, home, pathKey } = require('./nest');
const { size, ago, bar } = require('./tui');
const pkg = require('../package.json');

const HELP = `
  pigeon ${pkg.version} - your own locked drive, and files that fly between your devices

  pigeon                         open your nest (drop files onto the window to send them)
  pigeon dashboard               open your nest in the browser, already signed in
  pigeon app                     …in a window of its own, like an app
  pigeon home                    your own pigeon on this computer: works with no website at all
      --wifi                     …and let pigeon on your other computers use it too
  pigeon send <file|folder>…     send things to your nest (a file with the same name becomes a new version)
      --into Projects/game       …into a folder in your nest
      --to <device|all>          …straight to another device, or every one: it lands by itself
      --drop                     …and don't keep it in your nest once it lands
      --open                     …and open it when it lands (photos, PDFs, text)
      --expires 2d               …give up if it hasn't landed by then (default 7d)
  pigeon text "a link or note"   send some text: it lands on the other device's clipboard (--to …)
  pigeon clip                    send what's on your clipboard right now (--to …)
  pigeon roost on|off|status     land things by themselves in the background (Mac: every time you log in)
  pigeon rules                   where things land: photos in Pictures, PDFs in Documents, …
  pigeon sent                    what you sent to devices lately, and where it landed
  pigeon get [name]              save the newest file here (or the one whose name matches)
  pigeon ls [folder]             what's in your nest (or in one folder)
  pigeon rewind <name>           old versions of a file    --diff 2 (what changed)  --restore 2
  pigeon mkdir <folder>          make a folder         pigeon mv <name> <folder>   move something
  pigeon link <name>             a link + QR code anyone can open for 24 hours
  pigeon box new "Homework"      a drop box: a link anyone can send you files through (--days 14 --mb 200)
  pigeon box ls · box close <name> · box open <name>
  pigeon drop <link> <file>…     send files into someone's drop box (--name "Dhruv")
  pigeon devices                 every device signed in to your nest
  pigeon catch                   wait for files (from your phone, or sent to this computer) and save them
  pigeon sync [folder]           keep a copy of your nest in a folder (default ~/Pigeon)
      --watch                    …and keep it up to date while it runs
      --down                     …only download, never upload
  pigeon open <link>             save a file someone sent you as a pigeon link
  pigeon rm <name>               move something to the trash
  pigeon barn guide|add|ls|fix|size|rm    more room for your site from free buckets (site owner)
  pigeon console                 your site's live requests and errors, in the browser (owner: Touch ID, no password)  --here: in this window
  pigeon login · logout · whoami · site <address> · update · uninstall · --version
`;

const say = (s = '') => process.stdout.write(s + '\n');

function progress(label) {
  if (!process.stdout.isTTY) return () => {};
  return (d, t) => {
    process.stdout.write(`\r  ${label}  ${bar(t ? d / t : 1, 24, '█', '░')}  ${Math.round(t ? (100 * d) / t : 100)}%  ${size(d)}   `);
    if (d >= t) process.stdout.write('\n');
  };
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); else if (!/[\r\n]/.test(s)) rl.output.write('•'); else rl.output.write(s); };
    }
    rl.question(question, (a) => { rl.close(); resolve(a); });
  });
}

async function login(nest) {
  say(`  ${A.paint('pigeon', { bold: true })} ${Th.dim('· ' + nest.site)}`);
  const name = (await ask('  Nest name: ')).trim().toLowerCase();
  const pw = await ask('  Password: ', { hidden: true });
  let r = await nest.enter(name, pw, { make: 'ask' });
  if (r === 'new') {
    say(`  There's no nest called "${name}" yet - let's make it.`);
    const again = await ask('  Password again: ', { hidden: true });
    if (again !== pw) throw new Error("The two passwords don't match.");
    r = await nest.enter(name, pw, { make: true });
  }
  say(`  ${r === 'made' ? 'Made your nest' : 'Logged in to'} "${name}". Use the same name and password on your phone.`);
}

async function ready() {
  const nest = new Nest();
  if (!nest.in) {
    if (!process.stdin.isTTY) throw new Error('Log in first: pigeon login');
    await login(nest);
  }
  return nest;
}

function pick(files, want) {
  if (!want) return files[0];
  const w = want.toLowerCase();
  return files.find((f) => f.meta.name.toLowerCase() === w) || files.find((f) => f.meta.name.toLowerCase().includes(w)) || (/^\d+$/.test(want) ? files[Number(want) - 1] : null);
}

function showQr(url) {
  try {
    for (const l of QR.lines(url, { quiet: 2, paint: (s, fg, bg) => A.paint(s, { fg, bg }) })) say('  ' + l);
  } catch { /* too long for a QR code: the link is printed anyway */ }
}

/** Pull --flag value / --flag out of the arguments. */
function opts(args, withValue = [], flags = []) {
  const out = { rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i].replace(/^--?/, '');
    if (args[i].startsWith('-') && withValue.includes(a)) out[a] = args[++i];
    else if (args[i].startsWith('-') && flags.includes(a)) out[a] = true;
    else out.rest.push(args[i]);
  }
  return out;
}
const folderOf = (s) => String(s || '').split('/').map((x) => x.trim()).filter(Boolean);

async function findDevice(nest, want) {
  const list = (await nest.devices()).filter((d) => !d.me);
  const w = String(want || '').toLowerCase();
  const d = list.find((x) => x.name.toLowerCase() === w) || list.find((x) => x.name.toLowerCase().includes(w));
  if (!d) throw new Error(`No device called "${want}". Your devices: ${list.map((x) => x.name).join(', ') || '(none yet)'}`);
  return d;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  Th.use(session.load().theme || 'sky');
  switch (cmd) {
    case undefined: {
      if (!process.stdin.isTTY || !process.stdout.isTTY) { say(HELP); return; }
      const { App } = require('./app');
      await new App().run();
      return;
    }
    case '--version': case '-v': case 'version': say(`pigeon ${pkg.version}`); return;
    case 'help': case '--help': case '-h': say(HELP); return;
    case 'login': case 'signup': await login(new Nest()); return;
    case 'logout': { const n = new Nest(); await n.leave(); say('  Logged out on this computer.'); return; }
    case 'whoami': { const n = new Nest(); say(n.in ? `  ${n.name} · ${n.site}` : `  Not logged in · ${n.site}`); return; }
    case 'site': {
      if (!/^https?:\/\/\S+$/.test(rest[0] || '')) throw new Error('Usage: pigeon site https://your-site/pigeon');
      const url = rest[0].replace(/\/+$/, '');
      const s = session.load();
      const pins = { ...(s.pins || {}) };
      if (rest.includes('--trust')) { delete pins[url]; session.save({ ...s, pins }); say(`  pigeon will trust ${url}'s new key the next time it connects.`); return; }
      session.save({ ...s, site: url, token: undefined, key: undefined });
      say(`  Using ${url}. Log in with: pigeon login`);
      return;
    }
    case 'send': case 'up': case 'put': {
      const o = opts(rest, ['into', 'to', 'expires'], ['drop', 'open', 'new']);
      if (!o.rest.length) throw new Error('What should I send? pigeon send photo.jpg');
      for (const p of o.rest) if (!fs.existsSync(p)) throw new Error(`Can't find ${p}`);
      const nest = await ready();
      const folder = folderOf(o.into);
      const all = o.to === 'all';
      const to = o.to && !all ? await findDevice(nest, o.to) : null;
      const others = all ? (await nest.devices()).filter((d) => !d.me) : [];
      if (all && !others.length) throw new Error('No other devices are signed in to your nest yet. Sign in on another one first.');
      const hours = o.expires ? hoursOf(o.expires) : undefined;
      const { files } = await nest.list();
      if (folder.length) await nest.mkdir(folder, files);
      for (const p of o.rest) {
        // the same name in the same folder: this is a new version (Rewind keeps the old one)
        const same = o.new ? null : files.find((f) => f.done && !f.trashed && f.kind !== 'dir' && f.fileKey && f.meta.name === path.basename(path.resolve(p)) && pathKey(f.meta.path) === pathKey(folder));
        const r = await nest.send(p, { folder, to: to ? to.did : all ? others[0].did : undefined, drop: !!o.drop, open: !!o.open, hours, replaces: same && !to && !all ? same.id : undefined, onProgress: progress(`sending ${path.basename(p)}`) });
        if (all && others.length > 1) await nest.http('deliver', { body: { ids: [r.id], to: others.slice(1).map((d) => d.did), hours } });
        const where = to ? `is on its way to ${to.name}` : all ? `is on its way to ${others.length} devices` : `is in your nest${folder.length ? ' (' + folder.join(' › ') + ')' : ''}`;
        say(`  ${Th.ok('✓')} ${r.meta.name}${r.meta.kind === 'folder' ? '/' : ''} ${where}${same && !to && !all ? Th.dim(' · the old one is kept (pigeon rewind ' + r.meta.name + ')') : ''}${r.copied ? Th.dim(' · already there, so nothing to upload') : ''}.`);
      }
      return;
    }
    case 'text': case 'clip': case 'paste': {
      const o = opts(rest, ['to', 'expires'], ['open']);
      let text = cmd === 'text' ? o.rest.join(' ') : null;
      if (cmd !== 'text') {
        text = require('./roost').fromClipboard();
        if (!text || !text.trim()) throw new Error('Your clipboard is empty (or has a picture: send that with pigeon send).');
      }
      if (!text || !text.trim()) throw new Error('What should I send? pigeon text "https://…"');
      const nest = await ready();
      const all = !o.to || o.to === 'all';
      const others = (await nest.devices()).filter((d) => !d.me);
      const targets = all ? others : [await findDevice(nest, o.to)];
      if (!targets.length) throw new Error('No other devices are signed in to your nest yet. Sign in on another one first.');
      const r = await nest.sendText(text, { to: targets[0].did, drop: true, hours: o.expires ? hoursOf(o.expires) : 48 });
      if (targets.length > 1) await nest.http('deliver', { body: { ids: [r.id], to: targets.slice(1).map((d) => d.did), hours: 48 } });
      say(`  ${Th.ok('✓')} On its way to ${targets.length === 1 ? targets[0].name : targets.length + ' devices'}: it lands on the clipboard there.`);
      return;
    }
    case 'roost': {
      const R = require('./roost');
      const what = rest[0] || 'status';
      if (what === 'run') { await ready(); await R.run(); return; }
      if (what === 'once') { await ready(); await R.run({ once: true }); return; }
      if (what === 'on') {
        await ready();
        const r = R.on();
        if (!r.ok) throw new Error(r.why);
        say(`  ${Th.ok('✓')} pigeon is roosting. Things sent to this computer land by themselves now, and every time you log in.`);
        say(Th.dim(`  Where they go: pigeon rules · what it's doing: ${R.tilde(r.log)} · stop it: pigeon roost off`));
        return;
      }
      if (what === 'off') { R.off(); say('  The roost is off. Things sent to this computer wait until you open pigeon.'); return; }
      const st = R.status();
      say(st.on ? `  ${Th.ok('●')} Roosting: things sent here land by themselves.` : st.installed ? `  ${Th.dim('○')} Set up, but not running right now. Try: pigeon roost on` : `  ${Th.dim('○')} Not roosting. Start it with: pigeon roost on`);
      return;
    }
    case 'rules': return rulesCmd(rest);
    case 'sent': {
      const nest = await ready();
      const [list, devs] = await Promise.all([nest.sent(), nest.devices()]);
      const name = (did) => (devs.find((d) => d.did === did) || {}).name || 'a device that signed out';
      if (!list.length) { say('  Nothing sent to a device lately. Try: pigeon send photo.jpg --to all'); return; }
      for (const s of list.slice(0, 30)) {
        const mark = s.got ? Th.ok('✓') : s.gone ? Th.err('×') : Th.dim('…');
        const state = s.got ? `landed ${ago(s.got)}` : s.gone === 'expired' ? 'never came for it' : 'on its way';
        say(`  ${mark} ${String(s.meta.name).slice(0, 34).padEnd(35)} ${Th.dim('→')} ${name(s.to).slice(0, 26).padEnd(27)} ${Th.dim(state)}`);
      }
      return;
    }
    case 'rewind': case 'versions': case 'history': return rewindCmd(rest);
    case 'box': case 'boxes': return boxCmd(rest);
    case 'drop': {
      const o = opts(rest, ['name', 'note'], []);
      const [link, ...files] = o.rest;
      if (!link || !files.length) throw new Error('Usage: pigeon drop <drop box link> <file>…');
      for (const f of files) if (!fs.existsSync(f)) throw new Error(`Can't find ${f}`);
      const { dropInto } = require('./nest');
      const r = await dropInto(link, files, { name: o.name || require('./nest').device(), note: o.note, onProgress: (n, d, t) => progress(`dropping ${n}`)(d, t) });
      say(`  ${Th.ok('✓')} Dropped ${r.sent.length === 1 ? r.sent[0] : r.sent.length + ' files'} into "${r.title}". Only its owner can open ${r.sent.length === 1 ? 'it' : 'them'}.`);
      return;
    }
    case 'barn': case 'barns': return barnCmd(rest);
    case 'console': return consoleCmd(rest);
    case 'mkdir': {
      const folder = folderOf(rest.join(' '));
      if (!folder.length) throw new Error('Usage: pigeon mkdir Projects/game');
      const nest = await ready();
      await nest.mkdir(folder);
      say(`  ${Th.ok('✓')} ${folder.join(' › ')}/`);
      return;
    }
    case 'mv': case 'move': {
      if (rest.length < 2) throw new Error('Usage: pigeon mv <name> <folder>   (folder "/" is the top of your nest)');
      const nest = await ready();
      const { files } = await nest.list();
      const f = pick(files.filter((x) => x.done && !x.trashed && x.kind !== 'dir'), rest.slice(0, -1).join(' '));
      if (!f) throw new Error(`Nothing in your nest matches "${rest.slice(0, -1).join(' ')}".`);
      const dest = folderOf(rest[rest.length - 1]);
      if (dest.length) await nest.mkdir(dest, files);
      await nest.relabel([{ file: f, meta: { ...f.meta, path: dest } }]);
      say(`  ${Th.ok('✓')} ${f.meta.name} → ${dest.length ? dest.join(' › ') : 'My nest'}`);
      return;
    }
    case 'devices': {
      const nest = await ready();
      for (const d of await nest.devices()) say(`  ${d.me ? Th.teal('●') : Date.now() - d.seen < 120000 ? Th.ok('●') : Th.dim('○')} ${d.name.padEnd(34)} ${Th.dim(d.me ? 'this one' : Date.now() - d.seen < 120000 ? 'online now' : 'last seen ' + ago(d.seen))}${d.waiting ? Th.violet(`  ${d.waiting} waiting for it`) : ''}`);
      say(Th.dim('\n  Send straight to one: pigeon send photo.jpg --to "' + 'iPhone"'));
      return;
    }
    case 'app': case 'window': {
      await ready();
      const { serve } = require('./dashboard');
      const d = await serve({ saveDir: downloads(), openBrowser: false });
      const how = require('./home').openAsApp(d.url);
      say(`\n  Your nest is open ${how === 'window' ? 'in its own window' : 'in your browser (for a window of its own, install Google Chrome or Microsoft Edge)'}.`);
      say(`  ${Th.dim('Files you save land in ' + downloads().replace(require('os').homedir(), '~') + '. Keep this Terminal window open while you use it (Ctrl+C to stop).')}\n`);
      await new Promise(() => {});
      return;
    }
    case 'home': case 'here': case 'local': {
      const o = opts(rest, ['port'], ['wifi', 'app', 'no-open']);
      const H = require('./home');
      say(`\n  ${A.paint('pigeon home', { bold: true })} ${Th.dim('· starting your own pigeon on this computer…')}`);
      const h = await H.startHome({ port: Number(o.port) || 8787, wifi: !!o.wifi });
      say(`\n  It's running. Open it here:  ${A.paint(h.url, { bold: true })}`);
      if (!o['no-open']) { if (o.app) H.openAsApp(h.url); else require('./tui').open(h.url); }
      say(`  ${Th.dim('The first time, click "Make a nest" and pick a name and password. Your files stay in')}`);
      say(`  ${Th.dim(h.data.replace(require('os').homedir(), '~') + ', locked, and nothing goes to the website.')}`);
      if (o.wifi) say(h.wifiUrl ? `\n  Your other computers can use it too. On each one, type:\n    pigeon site ${h.wifiUrl.replace(/\/$/, '')}\n  ${Th.dim('(same Wi-Fi only, and this computer needs to stay on. Anyone on your Wi-Fi could make a nest here, so use --wifi at home, not at school or in a café)')}` : `\n  ${Th.dim("Couldn't find this computer's Wi-Fi address, so only this computer can use it.")}`);
      say(`\n  ${Th.dim('To use it from the terminal pigeon too:')} pigeon site ${h.url.replace(/\/$/, '')}`);
      say(`  ${Th.dim('Keep this window open while you use it. Press Ctrl+C to stop.')}\n`);
      const stop = () => { h.stop(); process.exit(0); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
      await new Promise(() => {});
      return;
    }
    case 'dashboard': case 'web': case 'browser': {
      await ready();
      const { serve } = require('./dashboard');
      const d = await serve({ saveDir: downloads() });
      say(`\n  Your nest is open in the browser: ${d.url}\n  ${Th.dim('Files you save land in ' + downloads().replace(require('os').homedir(), '~') + '. Keep this window open while you use it (Ctrl+C to stop).')}\n`);
      await new Promise(() => {});
      return;
    }
    case 'sync': {
      const o = opts(rest, [], ['watch', 'down']);
      const nest = await ready();
      const { syncOnce, defaultRoot } = require('./sync');
      const root = path.resolve(o.rest[0] || defaultRoot());
      say(`  Keeping a copy of your nest in ${root.replace(require('os').homedir(), '~')}${o.down ? ' (download only)' : ''}`);
      const onEvent = (e) => say(e.kind === 'error' ? `  ${Th.err('!')} ${e.name}: ${e.error}` : `  ${e.kind === 'down' ? Th.teal('↓') : Th.violet('↑')} ${e.name}`);
      for (;;) {
        try {
          const c = await syncOnce(nest, root, { up: !o.down, onEvent });
          if (!o.watch) { say(Th.dim(`  Done: ${c.down} down, ${c.up} up.`)); return; }
        } catch (e) { if (!o.watch) throw e; say(Th.dim(`  (${e.message} - trying again soon)`)); }
        await new Promise((r) => setTimeout(r, 20000));
      }
    }
    case 'get': case 'down': case 'pull': {
      const nest = await ready();
      const { files } = await nest.list();
      const done = files.filter((f) => f.done && !f.trashed && f.kind !== 'dir');
      if (!done.length) { say('  Your nest is empty.'); return; }
      const f = pick(done, rest.join(' '));
      if (!f) throw new Error(`Nothing in your nest matches "${rest.join(' ')}". See: pigeon ls`);
      const where = await nest.get(f, downloads(), { onProgress: progress(`fetching ${f.meta.name}`) });
      say(`  ${Th.ok('✓')} ${where}`);
      return;
    }
    case 'ls': case 'list': {
      const nest = await ready();
      const r = await nest.list();
      const { inside } = require('./nest');
      const folder = folderOf(rest.join(' '));
      const { dirs, files: here } = inside(r.files, folder);
      if (folder.length) say(Th.dim(`  ${['My nest', ...folder].join(' › ')}`));
      if (!dirs.length && !here.length) say(folder.length ? '  This folder is empty.' : '  Your nest is empty.');
      for (const d of dirs) say(`      ${Th.teal(d.name + '/')}`);
      here.sort((a, b) => b.made - a.made).forEach((f, i) => say(`  ${String(i + 1).padStart(2)}  ${(f.meta.name + (f.meta.kind === 'folder' ? '/' : '') + (f.meta.star ? ' ★' : '')).slice(0, 40).padEnd(41)} ${size(f.size).padStart(8)}  ${Th.dim(('from ' + (f.meta.from || '?')).slice(0, 24).padEnd(25))} ${Th.dim(ago(f.made))}`));
      say(Th.dim(`\n  ${size(r.used)} of ${size(r.quota)} used`));
      return;
    }
    case 'link': case 'share': {
      const nest = await ready();
      const { files } = await nest.list();
      const f = pick(files.filter((x) => x.done && !x.trashed && x.kind !== 'dir'), rest.filter((x) => !/^--/.test(x)).join(' '));
      if (!f) throw new Error('Which file? pigeon link <name>');
      const s = await nest.share(f, 24);
      say(`\n  ${A.paint(f.meta.name, { bold: true })} · anyone with this link can download it for 24 hours:\n`);
      showQr(s.url);
      say(`\n  ${s.url}\n`);
      return;
    }
    case 'catch': case 'wait': {
      const nest = await ready();
      const known = new Set((await nest.list()).files.map((f) => f.id));
      const seen = new Set();
      say(`\n  Waiting for files. On your phone, scan this (or open ${nest.site}) and send something.\n  Files other devices send straight to this computer land here too:\n`);
      showQr(nest.site);
      say(Th.dim('\n  (Ctrl+C to stop)\n'));
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        let files, inbox;
        try { ({ files } = await nest.list()); inbox = await nest.inbox(); } catch { continue; }
        for (const f of inbox.concat(files.filter((x) => x.done && !x.trashed && x.kind !== 'dir' && !known.has(x.id)))) {
          known.add(f.id);
          if (seen.has(f.id)) continue;
          seen.add(f.id);
          if (f.to && f.meta.clip) { await require('./roost').land(nest, f, require('./roost').rules(), { say: (t) => say(`  ${Th.ok('✓')} ${t}`) }); continue; }
          const where = await nest.get(f, downloads(), { onProgress: progress(`catching ${f.meta.name}`) });
          if (f.to) await nest.got(f, !!f.meta.drop).catch(() => {});
          say(`  ${Th.ok('✓')} ${where}`);
        }
      }
    }
    case 'open': {
      if (!rest[0]) throw new Error('Usage: pigeon open <link>');
      const where = await fetchShared(rest[0], downloads(), progress('fetching'));
      say(`  ${Th.ok('✓')} ${where}`);
      return;
    }
    case 'rm': case 'delete': {
      const nest = await ready();
      const { files } = await nest.list();
      const f = pick(files.filter((x) => !x.trashed && x.kind !== 'dir'), rest.join(' '));
      if (!f || !rest.length) throw new Error('Which file? pigeon rm <name>');
      await nest.trash([f]);
      say(`  Moved ${f.meta.name} to the trash. (It's deleted for good after 30 days; put it back from the trash in pigeon dashboard.)`);
      return;
    }
    case 'update': return update();
    case 'uninstall': return uninstall();
    default: throw new Error(`"${cmd}" isn't a pigeon command. Try: pigeon help`);
  }
}

/** "2d", "12h", "90m", "1w" → hours. */
function hoursOf(s) {
  const m = /^(\d+(?:\.\d+)?)\s*([mhdw]?)$/i.exec(String(s).trim());
  if (!m) throw new Error('Say how long like 30m, 12h, 2d or 1w.');
  const n = Number(m[1]);
  return { m: n / 60, h: n, '': n, d: n * 24, w: n * 168 }[m[2].toLowerCase()];
}

/** Where landed things go. */
async function rulesCmd(rest) {
  const R = require('./roost');
  const r = R.rules();
  const show = () => {
    say(`\n  ${A.paint('Where things land', { bold: true })} ${Th.dim('(things sent straight to this computer)')}\n`);
    let i = 1;
    for (const [k, v] of Object.entries(R.KINDS)) say(`  ${Th.teal(String(i++))}  ${v.label.padEnd(34)} ${r[k]}`);
    say(`  ${Th.teal(String(i++))}  ${'Everything else'.padEnd(34)} ${r.default}`);
    say(`  ${Th.teal(String(i++))}  ${'Show a notification'.padEnd(34)} ${r.notify !== false ? 'yes' : 'no'}`);
    say(`  ${Th.teal(String(i++))}  ${'Text and links go on the clipboard'.padEnd(34)} ${r.clipboard !== false ? 'yes' : 'no'}`);
    say(`  ${Th.teal(String(i++))}  ${'Links open in the browser'.padEnd(34)} ${r.links === 'open' ? 'yes' : 'no'}`);
    say(`  ${Th.teal(String(i++))}  ${'Open things when they land'.padEnd(34)} ${{ asked: 'when the sender asks (--open)', always: 'always', never: 'never' }[r.open] || 'when the sender asks'}`);
    say(Th.dim('\n  Photos, PDFs and text can open by themselves. Apps and scripts never do.'));
  };
  if (rest[0] === 'reset') { R.saveRules({}); say('  Back to how they started.'); return; }
  show();
  if (!process.stdin.isTTY) return;
  const keys = [...Object.keys(R.KINDS), 'default'];
  for (;;) {
    const a = (await ask('\n  Type a number to change it (Enter when you\'re done): ')).trim();
    if (!a) return;
    const n = Number(a);
    if (n >= 1 && n <= keys.length) {
      const k = keys[n - 1];
      const v = (await ask(`  New folder (now ${r[k]}): `)).trim();
      if (v) {
        const full = R.untilde(v);
        try { fs.mkdirSync(full, { recursive: true }); } catch (e) { say(Th.err(`  Can't use that folder: ${e.message}`)); continue; }
        r[k] = R.tilde(path.resolve(full));
      }
    } else if (n === keys.length + 1) r.notify = r.notify === false;
    else if (n === keys.length + 2) r.clipboard = r.clipboard === false;
    else if (n === keys.length + 3) r.links = r.links === 'open' ? 'clipboard' : 'open';
    else if (n === keys.length + 4) r.open = { asked: 'always', always: 'never', never: 'asked' }[r.open] || 'always';
    else { say('  Pick one of the numbers.'); continue; }
    R.saveRules(r);
    show();
  }
}

/** Rewind: a file's old versions, what changed, and bringing one back. */
async function rewindCmd(rest) {
  const o = opts(rest, ['diff', 'restore', 'get'], []);
  const want = o.rest.join(' ');
  if (!want) throw new Error('Which file? pigeon rewind essay.md');
  const nest = await ready();
  const { files } = await nest.list();
  const f = pick(files.filter((x) => x.done && !x.trashed && x.kind !== 'dir' && x.fileKey), want);
  if (!f) throw new Error(`Nothing in your nest matches "${want}".`);
  const vs = await nest.versions(f);
  const num = (x, label) => { const n = Number(x); if (!(n >= 1 && n <= vs.length)) throw new Error(`${label}: pick a version from 1 to ${vs.length} (see: pigeon rewind ${f.meta.name})`); return vs[n - 1]; };
  if (o.restore) {
    const v = num(o.restore, '--restore');
    if (v.id === f.id) { say('  That one is already the newest.'); return; }
    await nest.restore(v, f);
    say(`  ${Th.ok('✓')} ${f.meta.name} is back to how it was ${ago(v.made)}. (The one it replaced is kept too.)`);
    return;
  }
  if (o.get) {
    const v = num(o.get, '--get');
    const ext = path.extname(f.meta.name);
    const where = await nest.get(v, downloads(), { name: `${path.basename(f.meta.name, ext)} (version ${o.get})${ext}` });
    say(`  ${Th.ok('✓')} ${where}`);
    return;
  }
  if (o.diff) {
    const v = num(o.diff, '--diff');
    const D = require('./diff');
    const [a, b] = await Promise.all([nest.bytes(v), nest.bytes(vs[0])]);
    if (!D.isText(a) || !D.isText(b)) { say(`  ${f.meta.name} isn't text, so there's no line-by-line view. Version ${o.diff}: ${size(v.size)} · now: ${size(vs[0].size)}.`); return; }
    const d = D.texts(a.toString('utf8'), b.toString('utf8'));
    if (!d) { say('  Those two are too different to show line by line.'); return; }
    say(`\n  ${A.paint(f.meta.name, { bold: true })}: version ${o.diff} (${ago(v.made)}) → now   ${Th.ok('+' + d.added)} ${Th.err('-' + d.removed)}\n`);
    if (!d.hunks.length) say(Th.dim('  No changes.'));
    for (const h of d.hunks) {
      say(Th.teal(`  @@ line ${h.aStart + 1} → ${h.bStart + 1}`));
      for (const r of h.rows) {
        const line = r.s.length > 200 ? r.s.slice(0, 200) + '…' : r.s;
        say(r.t === '+' ? Th.ok(`  + ${line}`) : r.t === '-' ? Th.err(`  - ${line}`) : Th.dim(`    ${line}`));
      }
    }
    say('');
    return;
  }
  say(`\n  ${A.paint(f.meta.name, { bold: true })} ${Th.dim('· newest first · pigeon keeps the last 20, for 90 days')}\n`);
  vs.forEach((v, i) => say(`  ${Th.teal(String(i + 1).padStart(2))}  ${(i === 0 ? 'now' : ago(v.made)).padEnd(14)} ${size(v.size).padStart(8)}  ${Th.dim('from ' + String(v.meta.from || v.device || '?').slice(0, 30))}`));
  if (vs.length > 1) say(Th.dim(`\n  What changed:  pigeon rewind ${f.meta.name} --diff 2\n  Bring one back: pigeon rewind ${f.meta.name} --restore 2\n  Save a copy:    pigeon rewind ${f.meta.name} --get 2`));
  else say(Th.dim('\n  Only one version so far. Send a file with the same name to the same folder, and the old one is kept here.'));
  say('');
}

/** Drop boxes: links anyone can send you files through. */
async function boxCmd(rest) {
  const o = opts(rest, ['days', 'mb', 'note'], []);
  const [what, ...words] = o.rest;
  const nest = await ready();
  if (what === 'new' || what === 'make') {
    const title = words.join(' ').trim();
    if (!title) throw new Error('Give it a name: pigeon box new "Homework"');
    const b = await nest.newBox(title, { days: o.days ? Number(o.days) : 14, mb: o.mb ? Number(o.mb) : 200, note: o.note || '' });
    say(`\n  ${A.paint(`Drop box "${b.title}"`, { bold: true })} · anyone with this link can send you files until ${new Date(b.expires).toLocaleDateString()}:\n`);
    showQr(b.url);
    say(`\n  ${b.url}\n`);
    say(Th.dim(`  They need no account. Files are locked in their browser with this box's key, so only you can open them.\n  They show up in your nest under Drop boxes › ${b.title}. Close it with: pigeon box close "${b.title}"\n`));
    return;
  }
  const list = await nest.boxes();
  if (what === 'close' || what === 'open' || what === 'delete' || what === 'rm') {
    const w = words.join(' ').toLowerCase();
    const b = list.find((x) => x.title.toLowerCase() === w || x.code === w) || list.find((x) => x.title.toLowerCase().includes(w));
    if (!w || !b) throw new Error(`Which one? Your drop boxes: ${list.map((x) => '"' + x.title + '"').join(', ') || '(none yet)'}`);
    await nest.boxDo(b.code, what === 'rm' ? 'delete' : what);
    say(`  ${Th.ok('✓')} "${b.title}" is ${what === 'open' ? 'open again (for at least a day)' : what === 'close' ? 'closed: the link stops working' : 'gone (files already in your nest stay)'}.`);
    return;
  }
  if (!list.length) { say('  No drop boxes yet. Make one: pigeon box new "Homework"'); return; }
  for (const b of list) say(`  ${b.open ? Th.ok('●') : Th.dim('○')} ${b.title.slice(0, 30).padEnd(31)} ${String(b.files).padStart(3)} files  ${size(b.used).padStart(8)} of ${size(b.max).padEnd(8)} ${Th.dim(b.open ? 'open until ' + new Date(b.expires).toLocaleDateString() : 'closed')}\n    ${Th.link(b.url)}`);
}

/** Storage barns: more room for the site from free buckets (the site's owner). */
async function barnCmd(rest) {
  const B = require('./barn');
  const what = rest[0] || 'ls';
  if (what === 'guide' || what === 'help') {
    const which = (rest[1] || '').toLowerCase();
    for (const k of which ? [which] : ['b2', 'r2']) {
      const g = B.GUIDE[k];
      if (!g) throw new Error('pigeon barn guide b2   or   pigeon barn guide r2');
      say(`\n  ${A.paint(g.name, { bold: true })}\n  ${Th.dim('You need: ' + g.needs)}\n`);
      g.steps.forEach((st, i) => say(`  ${Th.teal(String(i + 1) + '.')} ${st}`));
      say(`\n  ${Th.dim(g.cors)}\n`);
    }
    return;
  }
  const nest = await ready();
  const showList = (r) => {
    say(`\n  ${A.paint('Room on your site', { bold: true })}  ${size(r.capacity)} in all\n`);
    say(`  ${Th.teal('●')} ${'This server'.padEnd(30)} ${size(r.disk.used).padStart(8)} of ${size(r.disk.quota)}`);
    for (const b of r.barns) say(`  ${b.state === 'ok' ? Th.ok('●') : Th.err('●')} ${(b.bucket + ' · ' + ({ b2: 'Backblaze B2', r2: 'Cloudflare R2', s3: 'S3' }[b.kind] || b.kind)).slice(0, 30).padEnd(30)} ${size(b.used).padStart(8)} of ${size(b.cap).padEnd(8)} ${Th.dim(b.state === 'ok' ? 'working · id ' + b.id : (b.note || 'not set up yet') + ' · id ' + b.id)}`);
    if (!r.barns.length) say(Th.dim('\n  No barns yet. Add a free one: pigeon barn guide'));
    say('');
  };
  const finish = async (id, setup) => {
    say('\n  Setting it up…');
    const res = await B.check(setup, (t) => say(`    ${/done|yes/.test(t) ? Th.ok('✓') : Th.dim('·')} ${t}`));
    const r = await nest.http('barns', { body: { do: 'ok', id, ...res } });
    if (res.works && res.cors) say(`\n  ${Th.ok('✓')} The barn works. New files go there now, and your site has ${size(r.capacity)} of room.\n`);
    else {
      say(`\n  ${Th.err('Not working yet:')} ${res.note || 'the test failed'}`);
      const g = B.GUIDE[setup.kind];
      if (res.works && !res.cors && g) say(`\n  ${g.cors}\n`);
      else say(Th.dim('  Check the endpoint, bucket name and keys, then: pigeon barn fix ' + id + '\n'));
    }
  };
  if (what === 'ls' || what === 'list') return showList(await nest.http('barns', { body: {} }));
  if (what === 'add') {
    say(`\n  ${A.paint('Add a storage barn', { bold: true })} ${Th.dim("(a free bucket that gives your site much more room; see: pigeon barn guide)")}\n`);
    const kind = ((await ask('  Which kind? b2 (Backblaze), r2 (Cloudflare) or s3 (other): ')).trim().toLowerCase() || 'b2').slice(0, 2);
    const k = { b2: 'b2', r2: 'r2' }[kind] || 's3';
    const endpoint = (await ask(k === 'b2' ? '  Endpoint (like s3.us-east-005.backblazeb2.com): ' : k === 'r2' ? '  Account ID (32 letters and numbers): ' : '  Endpoint (https://…): ')).trim();
    const region = k === 's3' ? (await ask('  Region (Enter for us-east-1): ')).trim() : '';
    const bucket = (await ask('  Bucket name: ')).trim();
    const akid = (await ask(k === 'b2' ? '  keyID: ' : '  Access Key ID: ')).trim();
    const secret = (await ask(k === 'b2' ? '  applicationKey: ' : '  Secret Access Key: ', { hidden: true })).trim();
    const gb = Number((await ask('  How many GB pigeon may use (Enter for 9, which stays inside the free 10 GB): ')).trim() || 9);
    const r = await nest.http('barns', { body: { do: 'add', kind: k, endpoint, region, bucket, akid, secret, gb } });
    return finish(r.id, r.setup);
  }
  const list = (await nest.http('barns', { body: {} })).barns;
  const b = rest[1] ? list.find((x) => x.id === rest[1] || x.bucket === rest[1]) : list.length === 1 ? list[0] : null;
  if (!b) throw new Error(list.length ? `Which barn? ${list.map((x) => x.bucket + ' (' + x.id + ')').join(', ')}` : 'No barns yet. Add one: pigeon barn add');
  if (what === 'fix' || what === 'check') { const r = await nest.http('barns', { body: { do: 'fix', id: b.id } }); return finish(b.id, r.setup); }
  if (what === 'size') {
    const gb = Number(rest[2] || (await ask(`  How many GB for ${b.bucket}? `)));
    return showList(await nest.http('barns', { body: { do: 'size', id: b.id, gb } }));
  }
  if (what === 'rm' || what === 'remove') {
    const force = rest.includes('--force');
    try { return showList(await nest.http('barns', { body: { do: 'remove', id: b.id, force } })); } catch (e) { throw new Error(`${e.message} To remove it anyway: pigeon barn rm ${b.id} --force`); }
  }
  throw new Error('pigeon barn guide | add | ls | fix | size | rm');
}

/** The developer console: live requests and errors from your pigeon site. */
async function consoleCmd(rest) {
  const nest = new Nest();
  if (rest.includes('--set') || rest.includes('--off')) {
    const me = await ready();
    if (rest.includes('--off')) { await me.http('console_set', { body: { password: null } }); say('  The console is off.'); return; }
    const pw = await ask('  New console password (8 or more characters): ', { hidden: true });
    if ((await ask('  Again: ', { hidden: true })) !== pw) throw new Error("The two don't match.");
    await me.http('console_set', { body: { password: pw } });
    say(`  ${Th.ok('✓')} Set. Open it with: pigeon console   (or ${me.site}/console in a browser)`);
    return;
  }
  const keyFile = path.join(home(), 'console.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(keyFile, 'utf8')); } catch { /* first time */ }
  let token = saved[nest.site];
  const here = rest.includes('--here') || rest.includes('--errors');
  // the site's owner, signed in on this computer: no password, just Touch ID (or the Mac's password)
  if (nest.in) {
    if (process.platform === 'darwin' && !rest.includes('--no-touch-id')) {
      const r = await require('./unlock').check('open the developer console');
      if (!r.ok && (r.why === 'cancelled' || /authentic|password|fail/i.test(r.why))) throw new Error(r.why === 'cancelled' ? 'Cancelled.' : `macOS didn't confirm it's you (${r.why}).`);
      // (if macOS couldn't ask at all, your pigeon sign-in is enough)
    }
    try {
      if (!here) {
        const { code } = await nest.http('console_link', {});
        const url = `${nest.site}/console#c=${code}`;
        require('./roost').openThing(url);
        say(`  ${Th.ok('✓')} The console is open in your browser. ${Th.dim('(In this window instead: pigeon console --here)')}`);
        return;
      }
      token = (await nest.http('console_owner', {})).token;
    } catch (e) {
      if (e.status !== 403) throw e;
      say(Th.dim(`  (You aren't this site's owner, so it's the console password.)`));
    }
  }
  const login = async () => {
    const pw = await ask(`  Console password for ${nest.site.replace(/^https?:\/\//, '')}: `, { hidden: true });
    token = (await nest.http('console_login', { body: { password: pw }, auth: false })).token;
    saved[nest.site] = token;
    fs.mkdirSync(home(), { recursive: true });
    fs.writeFileSync(keyFile, JSON.stringify(saved), { mode: 0o600 });
  };
  if (!token) await login();
  const errorsOnly = rest.includes('--errors');
  const color = (st) => (st >= 500 ? Th.err : st >= 400 ? Th.violet : Th.ok)(String(st || '…'));
  const row = (r) => `  ${Th.dim(new Date(r.t).toLocaleTimeString().padEnd(12))}${color(r.s)} ${String(r.a || r.p || '').slice(0, 22).padEnd(23)}${String(r.ms || 0).padStart(5)}ms ${Th.dim(String(r.n || '-').slice(0, 14).padEnd(15))}${Th.dim(r.ip || '')}${r.e ? '  ' + Th.err(String(r.e).slice(0, 70)) : ''}`;
  let since = 0;
  for (let first = true; ; first = false) {
    let v;
    try { v = await nest.http('console', { body: { token, since }, auth: false }); } catch (e) {
      if (e.status === 401) { say(Th.dim('  (signed out of the console)')); await login(); continue; }
      say(Th.dim(`  (${e.message} - trying again)`));
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (first) {
      const s = v.stats;
      say(`\n  ${A.paint('pigeon console', { bold: true })} ${Th.dim('· ' + nest.site + ' · v' + v.version)}`);
      say(`  ${s.hour} requests in the last hour · ${s.errorsHour ? Th.err(s.errorsHour + ' errors') : Th.ok('no errors')} · ${s.slowHour} slow · ${s.nests} nests · ${size(s.used)} of ${size(s.capacity)} · ${s.barns} barns${s.chores ? ' · ' + s.chores + ' pieces to clean up' : ''}`);
      if (v.errors.length) {
        say(`\n  ${Th.err('Latest errors')}`);
        for (const e of v.errors.slice(-3)) { say(row(e)); if (e.tb) say(Th.dim(e.tb.trim().split('\n').slice(-6).map((l) => '      ' + l).join('\n'))); }
      }
      say(`\n  ${Th.dim('time        status what                     time   nest           from')}`);
      say(Th.dim('  (live: new requests show up as they happen. Ctrl+C to stop)\n'));
    }
    const rows = v.rows.filter((r) => !errorsOnly || r.s >= 400);
    for (const r of first ? rows.slice(-25) : rows) {
      say(row(r));
      if (r.tb && !first) say(Th.dim(r.tb.trim().split('\n').slice(-6).map((l) => '      ' + l).join('\n')));
    }
    if (v.rows.length) since = v.rows[v.rows.length - 1].t;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function installUrl(kind) {
  let hub = '';
  try { hub = fs.readFileSync(path.join(home(), 'hub'), 'utf8').trim(); } catch { /* from GitHub */ }
  if (/^https?:\/\//.test(hub)) return `${hub.replace(/\/+$/, '')}/install.${kind}`;
  return `https://raw.githubusercontent.com/dpatel7-dev/pigeon/main/install.${kind}`;
}

function update() {
  const { spawnSync } = require('child_process');
  const win = process.platform === 'win32';
  const url = installUrl(win ? 'ps1' : 'sh');
  say(`  Updating from ${url}`);
  const r = win
    ? spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${url} | iex`], { stdio: 'inherit' })
    : spawnSync('sh', ['-c', `curl -fsSL "${url}" | sh`], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('The update did not finish. Your current version still works.');
}

function uninstall() {
  const root = home();
  let launcher = '';
  try { launcher = fs.readFileSync(path.join(root, 'launcher'), 'utf8').trim(); } catch { /* not from the installer */ }
  fs.rmSync(root, { recursive: true, force: true });
  if (launcher && /pigeon(\.cmd)?$/.test(launcher)) fs.rmSync(launcher, { force: true });
  say('  pigeon is uninstalled from this computer. (Your files are still in your nest on the website.)');
}

module.exports = { main, HELP };
