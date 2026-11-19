'use strict';
// `pigeon` and its sub-commands.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const A = require('./ansi');
const Th = require('./theme');
const QR = require('./qr');
const { Nest, fetchShared, downloads, session, home } = require('./nest');
const { size, ago, bar } = require('./tui');
const pkg = require('../package.json');

const HELP = `
  pigeon ${pkg.version} - your own locked drive, and files that fly between your devices

  pigeon                         open your nest (drop files onto the window to send them)
  pigeon dashboard               open your nest in the browser, already signed in
  pigeon app                     …in a window of its own, like an app
  pigeon home                    your own pigeon on this computer: works with no website at all
      --wifi                     …and let pigeon on your other computers use it too
  pigeon send <file|folder>…     send things to your nest (folders skip node_modules, .git…)
      --into Projects/game       …into a folder in your nest
      --to <device>              …straight to another device (it saves them by itself)
  pigeon get [name]              save the newest file here (or the one whose name matches)
  pigeon ls [folder]             what's in your nest (or in one folder)
  pigeon mkdir <folder>          make a folder         pigeon mv <name> <folder>   move something
  pigeon link <name>             a link + QR code anyone can open for 24 hours
  pigeon devices                 every device signed in to your nest
  pigeon catch                   wait for files (from your phone, or sent to this computer) and save them
  pigeon sync [folder]           keep a copy of your nest in a folder (default ~/Pigeon)
      --watch                    …and keep it up to date while it runs
      --down                     …only download, never upload
  pigeon open <link>             save a file someone sent you as a pigeon link
  pigeon rm <name>               move something to the trash
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
      session.save({ ...session.load(), site: rest[0].replace(/\/+$/, ''), token: undefined, key: undefined });
      say(`  Using ${rest[0]}. Log in with: pigeon login`);
      return;
    }
    case 'send': case 'up': case 'put': {
      const o = opts(rest, ['into', 'to'], ['drop']);
      if (!o.rest.length) throw new Error('What should I send? pigeon send photo.jpg');
      for (const p of o.rest) if (!fs.existsSync(p)) throw new Error(`Can't find ${p}`);
      const nest = await ready();
      const folder = folderOf(o.into);
      const to = o.to ? await findDevice(nest, o.to) : null;
      if (folder.length) await nest.mkdir(folder);
      for (const p of o.rest) {
        const r = await nest.send(p, { folder, to: to && to.did, drop: !!o.drop, onProgress: progress(`sending ${path.basename(p)}`) });
        say(`  ${Th.ok('✓')} ${r.meta.name}${r.meta.kind === 'folder' ? '/' : ''} ${to ? `is on its way to ${to.name}` : `is in your nest${folder.length ? ' (' + folder.join(' › ') + ')' : ''}`}.`);
      }
      return;
    }
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
