'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { PassThrough, Writable } = require('stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon-test-'));
process.env.PIGEON_HOME = path.join(tmp, 'home');
process.env.TUI_NO_OPEN = '1';
const C = require('../src/crypto');
const QR = require('../src/qr');
const { Nest, fetchShared, safeName } = require('../src/nest');
const { pathsIn } = require('../src/app');

let server;
let site;
test.before(async () => {
  server = spawn('python3', [path.join(__dirname, '..', 'server', 'pigeon_server.py'), '--port', '0', '--data', path.join(tmp, 'data'), '--quota-mb', '30'], { stdio: ['ignore', 'pipe', 'pipe'] });
  site = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { const m = /on (http:\/\/\S+)/.exec(String(d)); if (m) resolve(m[1]); });
    server.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
});
test.after(() => { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('locking: right key opens, anything else fails', async () => {
  const salt = C.newSalt();
  const a = await C.stretch('hunter22', salt);
  const b = await C.stretch('hunter22', salt);
  assert.equal(a.proof, b.proof);
  assert.notEqual(a.proof, a.key.toString('hex'), 'what proves who you are is not what locks your files');
  const fk = C.newFileKey();
  assert.deepEqual(C.unwrapKey(a.key, C.wrapKey(a.key, fk)), fk);
  const box = C.sealChunk(fk, 3, Buffer.from('hello'));
  assert.equal(C.openChunk(fk, 3, box).toString(), 'hello');
  assert.throws(() => C.openChunk(fk, 4, box), /couldn't unlock/, 'pieces cannot be swapped around');
  const wrong = await C.stretch('wrong password', salt);
  assert.throws(() => C.unwrapKey(wrong.key, C.wrapKey(a.key, fk)), /couldn't unlock/);
});

test('QR codes: grow with the text, refuse what is too long', () => {
  assert.equal(QR.encode('hi').version, 1);
  const link = 'https://djp7.pythonanywhere.com/pigeon/s/k7m2q9xw#' + 'A'.repeat(43);
  assert.equal(QR.encode(link).size, 41, 'a share link fits in version 6');
  assert.equal(QR.lines('hi', { quiet: 2 }).length, Math.ceil((21 + 4) / 2));
  assert.throws(() => QR.encode('x'.repeat(300)), /too long/);
});

test('a nest end to end: make, send a big file and a folder, get them back, share, delete', async () => {
  const nest = new Nest({ site });
  assert.equal(await nest.enter('dhruv', 'hunter22'), 'new');
  assert.equal(await nest.enter('dhruv', 'hunter22', { make: true }), 'made');
  const src = path.join(tmp, 'src');
  fs.mkdirSync(path.join(src, 'proj', 'node_modules'), { recursive: true });
  const big = crypto.randomBytes(C.CHUNK * 2 + 777);
  fs.writeFileSync(path.join(src, 'big.bin'), big);
  fs.writeFileSync(path.join(src, 'proj', 'main.py'), 'print(1)\n');
  fs.writeFileSync(path.join(src, 'proj', 'node_modules', 'huge.js'), 'x');
  const seen = [];
  await nest.send(path.join(src, 'big.bin'), { onProgress: (d, t) => seen.push(d / t) });
  assert.equal(seen[seen.length - 1], 1);
  assert.equal(seen.length, 3, 'three pieces');
  await nest.send(path.join(src, 'proj'));

  // a second device logs in with the same name and password
  process.env.PIGEON_HOME = path.join(tmp, 'home2');
  const phone = new Nest({ site });
  assert.equal(await phone.enter('dhruv', 'hunter22'), 'in');
  const { files, used, quota } = await phone.list();
  assert.deepEqual(files.map((f) => f.meta.name).sort(), ['big.bin', 'proj']);
  assert.ok(used > big.length && quota === 30 * 1024 * 1024);
  const out = path.join(tmp, 'out');
  const got = await phone.get(files.find((f) => f.meta.name === 'big.bin'), out);
  assert.ok(fs.readFileSync(got).equals(big), 'identical, byte for byte');
  const again = await phone.get(files.find((f) => f.meta.name === 'big.bin'), out);
  assert.equal(path.basename(again), 'big (2).bin', 'never overwrites');
  const dir = await phone.get(files.find((f) => f.meta.kind === 'folder'), out);
  assert.deepEqual(fs.readdirSync(dir), ['main.py'], 'folders skip node_modules');

  // the server only ever had locked bytes
  const data = path.join(tmp, 'data', 'files');
  for (const id of fs.readdirSync(data)) for (const p of fs.readdirSync(path.join(data, id))) assert.ok(!fs.readFileSync(path.join(data, id, p)).includes('print(1)'));

  // a link anyone can open; the key never goes to the server
  const s = await phone.share(files.find((f) => f.meta.name === 'big.bin'), 1);
  assert.match(s.url, /\/s\/[a-z2-9]{8}#[A-Za-z0-9_-]{43}$/);
  const via = await fetchShared(s.url, path.join(tmp, 'friend'));
  assert.ok(fs.readFileSync(via).equals(big));
  await assert.rejects(fetchShared(s.url.slice(0, -2) + 'AA', path.join(tmp, 'friend')), /couldn't unlock/);

  // wrong password, strangers, and a full nest
  await assert.rejects(new Nest({ site }).enter('dhruv', 'nope'), /Wrong nest name or password/);
  await assert.rejects(new Nest({ site }).enter('mallory', 'pw123456', { make: true }), /invite code/);
  assert.equal(await new Nest({ site }).enter('mallory', 'pw123456'), 'invite', 'asks for an invite instead of failing');
  fs.writeFileSync(path.join(src, 'huge.bin'), crypto.randomBytes(25 * 1024 * 1024));
  await assert.rejects(phone.send(path.join(src, 'huge.bin')), /no room left/);

  await phone.remove(files.find((f) => f.meta.name === 'big.bin'));
  assert.equal((await phone.list()).files.length, 1);
  await assert.rejects(fetchShared(s.url, path.join(tmp, 'friend')), /deleted|expired/);
});

test('a drive: folders, rename, move, stars, trash, devices, sending to a device, invites', async () => {
  process.env.PIGEON_HOME = path.join(tmp, 'home3');
  const laptop = new Nest({ site });
  assert.equal(await laptop.enter('dhruv', 'hunter22'), 'in');
  const src = path.join(tmp, 'drive');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'a.txt'), 'alpha');
  fs.writeFileSync(path.join(src, 'b.txt'), 'beta');

  await laptop.mkdir(['Projects', 'game']);
  await laptop.send(path.join(src, 'a.txt'), { folder: ['Projects', 'game'] });
  await laptop.send(path.join(src, 'b.txt'));
  let { files } = await laptop.list();
  const { inside, under } = require('../src/nest');
  assert.deepEqual(inside(files, []).dirs.map((d) => d.name), ['Projects']);
  assert.deepEqual(inside(files, ['Projects']).dirs.map((d) => d.name), ['game']);
  assert.deepEqual(inside(files, ['Projects', 'game']).files.map((f) => f.meta.name), ['a.txt']);

  // rename + move + star are just new (locked) labels
  const b = files.find((f) => f.meta.name === 'b.txt');
  await laptop.relabel([{ file: b, meta: { ...b.meta, name: 'notes.txt', path: ['Projects'], star: true } }]);
  ({ files } = await laptop.list());
  const n = files.find((f) => f.id === b.id);
  assert.equal(n.meta.name, 'notes.txt');
  assert.deepEqual(n.meta.path, ['Projects']);
  assert.equal(n.meta.star, true);
  const db = fs.readFileSync(path.join(tmp, 'data', 'pigeon.db'));
  assert.ok(!db.includes('notes.txt') && !db.includes('Projects'), 'the website never sees names or folders');

  // the trash, and putting things back
  await laptop.trash(under(files, ['Projects']));
  ({ files } = await laptop.list());
  assert.equal(inside(files, []).dirs.length, 0);
  await laptop.trash(under(files, ['Projects']), true);
  ({ files } = await laptop.list());
  assert.deepEqual(inside(files, []).dirs.map((d) => d.name), ['Projects']);

  // a second device, and a file sent straight to it
  process.env.PIGEON_HOME = path.join(tmp, 'home4');
  const phone = new Nest({ site });
  await phone.enter('dhruv', 'hunter22');
  assert.notEqual(phone.did, laptop.did);
  const devices = await laptop.devices();
  const target = devices.find((d) => d.did === phone.did);
  assert.ok(target && !target.me && devices.find((d) => d.me).did === laptop.did);
  fs.writeFileSync(path.join(src, 'for-phone.txt'), 'hello phone');
  await laptop.send(path.join(src, 'for-phone.txt'), { to: phone.did, drop: true });
  assert.equal((await laptop.inbox()).length, 0, 'not for the laptop');
  const box = await phone.inbox();
  assert.deepEqual(box.map((f) => f.meta.name), ['for-phone.txt']);
  const got = await phone.get(box[0], path.join(tmp, 'phone-dl'));
  assert.equal(fs.readFileSync(got, 'utf8'), 'hello phone');
  await phone.got(box[0], true);
  assert.equal((await phone.inbox()).length, 0);
  assert.ok(!(await phone.list()).files.some((f) => f.meta.name === 'for-phone.txt'), 'a drop-off is gone once it arrives');
  // and an existing file, delivered without uploading it again
  await laptop.http('deliver', { body: { ids: [b.id], to: phone.did } });
  assert.deepEqual((await phone.inbox()).map((f) => f.meta.name), ['notes.txt']);

  // invites: the owner makes one, it makes exactly one nest
  const inv = await laptop.invite();
  process.env.PIGEON_HOME = path.join(tmp, 'home5');
  const friend = new Nest({ site });
  assert.equal(await friend.enter('friend.one', 'friendpw', { make: true, invite: inv.code }), 'made');
  await assert.rejects(friend.invite(), /owner/);
  process.env.PIGEON_HOME = path.join(tmp, 'home6');
  await assert.rejects(new Nest({ site }).enter('friend.two', 'friendpw', { make: true, invite: inv.code }), /doesn't work/);
  assert.equal((await friend.list()).files.length, 0, "a friend's nest is their own");
});

test('keeping a copy in a folder (sync), both ways', async () => {
  process.env.PIGEON_HOME = path.join(tmp, 'home3');
  const nest = new Nest();
  const { syncOnce } = require('../src/sync');
  const root = path.join(tmp, 'Pigeon');
  const first = await syncOnce(nest, root);
  assert.ok(first.down >= 2);
  assert.equal(fs.readFileSync(path.join(root, 'Projects', 'game', 'a.txt'), 'utf8'), 'alpha');
  assert.ok(fs.existsSync(path.join(root, 'Projects', 'notes.txt')));
  fs.writeFileSync(path.join(root, 'Projects', 'new.md'), '# new');
  fs.mkdirSync(path.join(root, 'Projects', 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Projects', 'node_modules', 'x.js'), 'skip me');
  const second = await syncOnce(nest, root);
  assert.equal(second.up, 1, 'only the new file goes up');
  const { files } = await nest.list();
  assert.ok(files.some((f) => f.meta.name === 'new.md' && f.meta.path.join('/') === 'Projects'));
  const third = await syncOnce(nest, root);
  assert.deepEqual(third, { down: 0, up: 0 }, 'nothing moves when nothing changed');
});

test('the browser dashboard: signed in, passes requests along, saves to this computer', async () => {
  process.env.PIGEON_HOME = path.join(tmp, 'home3');
  const save = path.join(tmp, 'dash-saves');
  const { serve } = require('../src/dashboard');
  const d = await serve({ saveDir: save, openBrowser: false });
  try {
    const page = await (await fetch(d.url)).text();
    assert.match(page, /"session":\{"nest":"dhruv"/);
    assert.ok(!page.includes('/*PIGEON_QR*/'));
    const base = d.url.replace(/\/$/, '');
    const s = new Nest();
    const list = await (await fetch(base + '/p/api/list', { method: 'POST', headers: { authorization: 'Bearer ' + s.token, 'content-type': 'application/json' }, body: '{}' })).json();
    assert.ok(Array.isArray(list.files) && list.files.length > 0);
    const r = await (await fetch(base + '/local/save?name=hi.txt&path=Projects', { method: 'POST', body: 'hello' })).json();
    assert.equal(fs.readFileSync(path.join(save, 'Projects', 'hi.txt'), 'utf8'), 'hello');
    assert.match(r.where, /hi\.txt$/);
    const wrong = await fetch(d.url.replace(/\/[a-f0-9]+\/$/, '/nope/'));
    assert.equal(wrong.status, 404, 'only the secret address works');
  } finally { d.close(); }
});

test('pixel art and QR codes never use the upper-half block (it leaves seams in macOS Terminal)', () => {
  const A = require('../src/ansi');
  const S = require('../src/sprite');
  const Coo = require('../src/bird');
  const before = A.getLevel();
  for (const level of [2, 3]) {
    A.setLevel(level);
    const art = Coo.draw('idle', 0, '#f5f7fa').join('\n');
    assert.doesNotMatch(art, /▀/);
    assert.match(art, /▄/);
    assert.doesNotMatch(S.draw(['AB', 'B.', '.A', 'AA'], { A: '#ff0000', B: '#00ff00' }, { bg: '#000000' }).join(''), /▀/);
    const qr = QR.lines('https://example.com', { paint: (t, fg, bg) => A.paint(t, { fg, bg }) }).join('');
    assert.doesNotMatch(qr, /[▀█]/);
  }
  A.setLevel(before);
});

test('paths from drag and drop', () => {
  assert.deepEqual(pathsIn("'/Users/me/My Photo.jpg' /tmp/a\\ b.txt \"/x y/z\""), ['/Users/me/My Photo.jpg', '/tmp/a b.txt', '/x y/z']);
  assert.deepEqual(pathsIn('file:///tmp/hello%20world.txt'), ['/tmp/hello world.txt']);
  assert.ok(!safeName('../../etc/passwd').includes('/'));
  assert.equal(safeName('con.txt'), 'file-con.txt');
});

test('the screen: list, link panel with a QR code, quit', async () => {
  process.env.PIGEON_HOME = path.join(tmp, 'home2');
  const input = new PassThrough();
  input.setRawMode = () => {};
  let drawn = '';
  const output = new Writable({ write(c, e, cb) { drawn += c.toString(); cb(); } });
  output.columns = 100;
  output.rows = 40;
  const { App } = require('../src/app');
  const app = new App({ input, output });
  const done = app.run();
  try {
  const has = () => app.files.findIndex((f) => f.meta.name === 'proj');
  for (let i = 0; i < 150 && has() < 0; i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(has() >= 0);
  assert.ok(app.files[0].dir, 'folders come first');
  await new Promise((r) => setTimeout(r, 50));
  assert.match(drawn, /proj\//);
  assert.match(drawn, /Projects\//);
  app.sel = has();
  input.write('l');
  for (let i = 0; i < 100 && !app.panel; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.panel.kind, 'qr');
  await new Promise((r) => setTimeout(r, 50));
  assert.match(drawn, /▄/);
  input.write('\x1b');
  await new Promise((r) => setTimeout(r, 80));
  // into a folder and back out
  app.sel = 0;
  input.write('\r');
  for (let i = 0; i < 50 && !app.path.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(app.path, ['Projects']);
  input.write('\x1b[D');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(app.path, []);
  input.write('q');
  await done;
  } finally { app.quit(); }
});
