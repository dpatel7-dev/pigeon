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
  pigeon ${pkg.version} - move files between your devices, locked on the way

  pigeon                       open your nest (drop files onto the window to send)
  pigeon send <file|folder>…   send things to your nest (folders skip node_modules, .git…)
  pigeon get [name]            save the newest file here (or the one whose name matches)
  pigeon ls                    what's in your nest
  pigeon link <name>           a link + QR code anyone can open for 24 hours
  pigeon catch                 wait for a file from your phone and save it when it lands
  pigeon open <link>           save a file someone sent you as a pigeon link
  pigeon rm <name>             delete from your nest
  pigeon login                 log in (or make a nest)      pigeon logout
  pigeon site <address>        use a different pigeon website
  pigeon update · pigeon uninstall · pigeon --version
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
      if (!rest.length) throw new Error('What should I send? pigeon send photo.jpg');
      for (const p of rest) if (!fs.existsSync(p)) throw new Error(`Can't find ${p}`);
      const nest = await ready();
      for (const p of rest) {
        const r = await nest.send(p, { onProgress: progress(`sending ${path.basename(p)}`) });
        say(`  ${Th.ok('✓')} ${r.meta.name}${r.meta.kind === 'folder' ? '/' : ''} is in your nest.`);
      }
      return;
    }
    case 'get': case 'down': case 'pull': {
      const nest = await ready();
      const { files } = await nest.list();
      const done = files.filter((f) => f.done);
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
      const done = r.files.filter((f) => f.done);
      if (!done.length) say('  Your nest is empty.');
      done.forEach((f, i) => say(`  ${String(i + 1).padStart(2)}  ${(f.meta.name + (f.meta.kind === 'folder' ? '/' : '')).slice(0, 40).padEnd(41)} ${size(f.size).padStart(8)}  ${Th.dim(('from ' + (f.meta.from || '?')).slice(0, 24).padEnd(25))} ${Th.dim(ago(f.made))}`));
      say(Th.dim(`\n  ${size(r.used)} of ${size(r.quota)} used`));
      return;
    }
    case 'link': case 'share': {
      const nest = await ready();
      const { files } = await nest.list();
      const f = pick(files.filter((x) => x.done), rest.filter((x) => !/^--/.test(x)).join(' '));
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
      say(`\n  Waiting for a file. On your phone, scan this (or open ${nest.site}) and send something:\n`);
      showQr(nest.site);
      say(Th.dim('\n  (Ctrl+C to stop)\n'));
      for (;;) {
        await new Promise((r) => setTimeout(r, 2000));
        let files;
        try { ({ files } = await nest.list()); } catch { continue; }
        for (const f of files.filter((x) => x.done && !known.has(x.id))) {
          known.add(f.id);
          const where = await nest.get(f, downloads(), { onProgress: progress(`catching ${f.meta.name}`) });
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
      const f = pick(files, rest.join(' '));
      if (!f || !rest.length) throw new Error('Which file? pigeon rm <name>');
      await nest.remove(f);
      say(`  Deleted ${f.meta.name}.`);
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
