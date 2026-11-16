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
  await assert.rejects(new Nest({ site }).enter('mallory', 'pw123456', { make: true }), /isn't taking new ones/);
  fs.writeFileSync(path.join(src, 'huge.bin'), crypto.randomBytes(25 * 1024 * 1024));
  await assert.rejects(phone.send(path.join(src, 'huge.bin')), /no room left/);

  await phone.remove(files.find((f) => f.meta.name === 'big.bin'));
  assert.equal((await phone.list()).files.length, 1);
  await assert.rejects(fetchShared(s.url, path.join(tmp, 'friend')), /deleted|expired/);
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
  for (let i = 0; i < 100 && !app.files.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.files.length, 1);
  await new Promise((r) => setTimeout(r, 50));
  assert.match(drawn, /proj\//);
  input.write('l');
  for (let i = 0; i < 100 && !app.panel; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(app.panel.kind, 'qr');
  await new Promise((r) => setTimeout(r, 50));
  assert.match(drawn, /█/);
  input.write('\x1b');
  await new Promise((r) => setTimeout(r, 80));
  input.write('q');
  await done;
});
