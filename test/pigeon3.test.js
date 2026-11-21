'use strict';
// pigeon 3: sealed requests, squeezing, no doubles, Rewind, homing, drop boxes, barns, the console.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pigeon3-test-'));
process.env.PIGEON_HOME = path.join(tmp, 'home');
const C = require('../src/crypto');
const W = require('../src/wire');
const Barn = require('../src/barn');
const FakeS3 = require('./fake-s3');
const { Nest, fetchShared, dropInto } = require('../src/nest');

let server, site;
const data = path.join(tmp, 'data');
test.before(async () => {
  server = spawn('python3', [path.join(__dirname, '..', 'server', 'pigeon_server.py'), '--port', '0', '--data', data, '--quota-mb', '40'], { stdio: ['ignore', 'pipe', 'pipe'] });
  site = await new Promise((resolve, reject) => {
    server.stdout.on('data', (d) => { const m = /on (http:\/\/\S+)/.exec(String(d)); if (m) resolve(m[1]); });
    server.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
});
test.after(() => { server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); });

const as = (who) => { process.env.PIGEON_HOME = path.join(tmp, who); return new Nest({ site }); };
const sqlite = (sql) => spawnSync('python3', ['-c', `import sqlite3,json,sys;c=sqlite3.connect(sys.argv[1]);print(json.dumps([list(r) for r in c.execute(sys.argv[2]).fetchall()]))`, path.join(data, 'pigeon.db'), sql], { encoding: 'utf8' });
const rows = (sql) => JSON.parse(sqlite(sql).stdout);
const file = (name, content) => { const f = path.join(tmp, 'src', name); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); return f; };

let owner, laptop;
test('sealed requests: only locked blobs on the wire, and nothing can be changed or replayed', async () => {
  owner = as('owner');
  assert.equal(await owner.enter('dhruv', 'hunter22', { make: true }), 'made');
  assert.ok(owner.wire, 'it talks over the sealed wire');
  // the site's key is remembered the first time
  const pins = JSON.parse(fs.readFileSync(path.join(tmp, 'owner', 'session.json'), 'utf8')).pins;
  assert.equal(pins[site].length, 512);
  // what goes over the wire has none of what was asked
  const sent = owner.wire.seal('login', { nest: 'dhruv', proof: 'f'.repeat(64) }, owner.token);
  const text = Buffer.from(sent.frame).toString('latin1');
  assert.ok(!text.includes('dhruv') && !text.includes('login') && !text.includes(owner.token));
  // a changed byte is refused
  const post = (frame) => fetch(`${site}/api/w`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: frame });
  const ok = owner.wire.seal('list', {}, owner.token);
  const bad = Uint8Array.from(ok.frame); bad[bad.length - 40] ^= 1;
  const r1 = await post(bad);
  assert.equal(r1.status, 400);
  // the same "change something" request twice: the second is refused
  const t = owner.wire.seal('trash', { ids: ['0123456789abcdef'], restore: true }, owner.token);
  const a = owner.wire.open(new Uint8Array(await (await post(t.frame)).arrayBuffer()), t);
  assert.equal(a.obj.s, 200);
  const again = await post(t.frame);
  const b = owner.wire.open(new Uint8Array(await again.arrayBuffer()), t);
  assert.equal(b.obj.s, 409, 'replayed');
  // a channel the site forgot: the device starts a new one by itself
  spawnSync('python3', ['-c', `import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);c.execute('DELETE FROM wires');c.commit()`, path.join(data, 'pigeon.db')]);
  assert.ok(Array.isArray((await owner.list()).files));
  // a different key for the same site is refused
  process.env.PIGEON_HOME = path.join(tmp, 'owner');
  const s = JSON.parse(fs.readFileSync(path.join(tmp, 'owner', 'session.json'), 'utf8'));
  fs.writeFileSync(path.join(tmp, 'owner', 'session.json'), JSON.stringify({ ...s, pins: { [site]: 'ab'.repeat(256) } }));
  await assert.rejects(new Nest().list(), /different key than before/);
  fs.writeFileSync(path.join(tmp, 'owner', 'session.json'), JSON.stringify(s));
  // device names are locked too
  laptop = as('laptop');
  await laptop.enter('dhruv', 'hunter22');
  await laptop.nameDevice('School MacBook');
  const names = rows('SELECT device FROM tokens').map((r) => r[0]);
  assert.ok(names.every((n) => n.startsWith('l1:')), 'the site only has locked names');
  assert.ok((await owner.devices()).some((d) => d.name === 'School MacBook'));
});

test('the plain API still works for older apps, until the owner turns it off', async () => {
  const hi = await fetch(`${site}/api/hello`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nest":"dhruv"}' }).then((r) => r.json());
  assert.equal(hi.exists, true);
  await owner.http('people', { body: { do: 'sealed', on: true } });
  const r = await fetch(`${site}/api/hello`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"nest":"dhruv"}' });
  assert.equal(r.status, 403);
  await owner.http('people', { body: { do: 'sealed', on: false } });
});

test('squeezing: text gets smaller, photos are left alone, both come back exact', async () => {
  const before = (await owner.list()).used;
  const text = Buffer.from('const greeting = "hello from pigeon";\n'.repeat(60000)); // 2.3 MB of very squeezable code
  await owner.send(file('code.js', text));
  const after = (await owner.list()).used;
  assert.ok(after - before < text.length / 10, `stored ${after - before} for ${text.length}`);
  const photo = crypto.randomBytes(300000);
  await owner.send(file('photo.jpg', photo));
  const { files } = await laptop.list();
  const out = path.join(tmp, 'out1');
  assert.ok(fs.readFileSync(await laptop.get(files.find((f) => f.meta.name === 'code.js'), out)).equals(text));
  assert.ok(fs.readFileSync(await laptop.get(files.find((f) => f.meta.name === 'photo.jpg'), out)).equals(photo));
  assert.equal(files.find((f) => f.meta.name === 'code.js').meta.z, 1);
});

test('no doubles: the same bytes sent again take no more room, and outlive the first copy', async () => {
  const big = crypto.randomBytes(C.CHUNK + 5000);
  const f1 = file('a/movie.bin', big);
  const f2 = file('b/movie copy.bin', big);
  await owner.send(f1);
  const used1 = (await owner.list()).used;
  const r = await owner.send(f2, { folder: ['Backups'] });
  assert.equal(r.copied, true);
  const { files, used } = await owner.list();
  assert.equal(used, used1, 'no extra room used');
  const first = files.find((f) => f.meta.name === 'movie.bin');
  const copy = files.find((f) => f.meta.name === 'movie copy.bin');
  assert.deepEqual(copy.meta.path, ['Backups']);
  await owner.remove(first);
  const after = await owner.list();
  assert.ok(after.used >= big.length, 'the copy now counts the bytes');
  const got = await owner.get(after.files.find((f) => f.id === copy.id), path.join(tmp, 'out2'));
  assert.ok(fs.readFileSync(got).equals(big));
});

test('Rewind: a new version keeps the old one, with a way back', async () => {
  const f = file('notes/essay.md', 'first draft\n');
  await owner.send(f, { folder: ['School'] });
  let cur = (await owner.list()).files.find((x) => x.meta.name === 'essay.md');
  fs.writeFileSync(f, 'second draft, much better\n');
  await owner.send(f, { folder: ['School'], replaces: cur.id });
  const { files } = await owner.list();
  const now = files.filter((x) => x.meta.name === 'essay.md');
  assert.equal(now.length, 1, 'one essay in the drive');
  assert.equal(now[0].vers, 1, 'with one older version');
  const vs = await owner.versions(now[0]);
  assert.equal(vs.length, 2);
  assert.equal((await owner.bytes(vs[0])).toString(), 'second draft, much better\n');
  assert.equal((await owner.bytes(vs[1])).toString(), 'first draft\n');
  await owner.restore(vs[1], now[0]);
  cur = (await owner.list()).files.find((x) => x.meta.name === 'essay.md');
  assert.equal((await owner.bytes(cur)).toString(), 'first draft\n');
  assert.equal((await owner.versions(cur)).length, 3, 'bringing one back is a version too');
  // trashing it takes its versions along, putting it back brings them too
  await owner.trash([cur]);
  assert.equal(rows(`SELECT COUNT(*) FROM files WHERE line = '${cur.line}' AND trashed = 0`)[0][0], 0);
  await owner.trash([cur], true);
  assert.equal(rows(`SELECT COUNT(*) FROM files WHERE line = '${cur.line}' AND trashed = 0`)[0][0], 3);
});

test('homing: send to every device, it lands, and the sender gets a receipt', async () => {
  const phone = as('phone');
  await phone.enter('dhruv', 'hunter22');
  await owner.send(file('slides.pdf', 'pretend pdf'));
  const slides = (await owner.list()).files.find((f) => f.meta.name === 'slides.pdf');
  const r = await owner.deliver([slides], 'all');
  assert.equal(r.sent, 2, 'the laptop and the phone');
  for (const dev of [laptop, phone]) {
    const inbox = await dev.inbox();
    assert.equal(inbox.length, 1);
    assert.equal((await dev.bytes(inbox[0])).toString(), 'pretend pdf');
    await dev.got(inbox[0]);
    assert.equal((await dev.inbox()).length, 0);
  }
  const sent = await owner.sent();
  const these = sent.filter((s) => s.meta.name === 'slides.pdf');
  assert.equal(these.length, 2);
  assert.ok(these.every((s) => s.got > 0), 'both landed');
  assert.equal((await owner.list()).files.filter((f) => f.meta.name === 'slides.pdf').length, 1, 'the copies on their way never cluttered the drive');
  // a bit of text, for the clipboard
  await phone.sendText('https://example.com/homework', { to: laptop.did, drop: true });
  const inbox = await laptop.inbox();
  assert.equal(inbox[0].meta.clip, true);
  assert.equal((await laptop.bytes(inbox[0])).toString(), 'https://example.com/homework');
});

test('drop boxes: anyone can send, only the owner can open', async () => {
  const box = await owner.newBox('Homework', { days: 3, mb: 10, note: 'Put your essays here' });
  assert.match(box.url, /\/d\/[a-z2-9]{10}$/);
  process.env.PIGEON_HOME = path.join(tmp, 'stranger');
  const essay = file('stranger/my essay.txt', 'The pigeon is a remarkable bird.\n'.repeat(100));
  const r = await dropInto(box.url, [essay], { name: 'Sam' });
  assert.equal(r.title, 'Homework');
  // the site has it, but only as locked bytes nobody else can open
  assert.equal(rows("SELECT COUNT(*) FROM files WHERE box IS NOT NULL")[0][0], 1);
  const { files } = await owner.list();
  const got = files.find((f) => f.meta.name === 'my essay.txt');
  assert.ok(got, 'it shows up in the drive');
  assert.deepEqual(got.meta.path, ['Drop boxes', 'Homework']);
  assert.match(got.meta.from, /Sam/);
  assert.equal((await owner.bytes(got)).toString(), fs.readFileSync(essay, 'utf8'));
  // and on the owner's other devices too, now that it's locked with the nest's key
  assert.ok((await laptop.list()).files.find((f) => f.meta.name === 'my essay.txt').fileKey);
  // too big, or closed: refused
  await assert.rejects(dropInto(box.url, [file('stranger/huge.bin', crypto.randomBytes(11 * 1024 * 1024))]), /room/);
  await owner.boxDo(box.code, 'close');
  await assert.rejects(dropInto(box.url, [essay]), /closed/);
});

test('barns: pieces go straight to a bucket, come back, and are cleaned up', async () => {
  const s3 = await FakeS3.start({ akid: 'TESTKEY12345', secret: 'testsecret/abcdefghij', bucket: 'pigeon-test' });
  try {
    const add = await owner.http('barns', { body: { do: 'add', kind: 's3', endpoint: s3.url, bucket: 'pigeon-test', akid: 'TESTKEY12345', secret: 'testsecret/abcdefghij', gb: 1 } });
    const said = [];
    const res = await Barn.check(add.setup, (t) => said.push(t));
    assert.deepEqual([res.works, res.cors, res.signlen], [true, true, true], said.join('\n'));
    assert.match(s3.state.cors, /AllowedOrigin>\*</);
    await owner.http('barns', { body: { do: 'ok', id: add.id, ...res } });
    const list = await owner.http('barns', { body: {} });
    assert.equal(list.barns[0].state, 'ok');
    assert.ok(!JSON.stringify(list).includes('testsecret'), 'the secret never comes back out');
    assert.ok(list.capacity > 1024 * 1024 * 1024);
    // a big file now lives in the barn, not on the site
    const big = crypto.randomBytes(C.CHUNK * 2 + 11);
    await owner.send(file('big/backup.bin', big));
    const f = (await laptop.list()).files.find((x) => x.meta.name === 'backup.bin');
    assert.equal(f.barn, true);
    assert.equal([...s3.store.keys()].filter((k) => k.startsWith(`pigeon/${f.id}/`)).length, 3);
    assert.ok(!fs.existsSync(path.join(data, 'files', f.id)), 'nothing on the site');
    assert.ok(fs.readFileSync(await laptop.get(f, path.join(tmp, 'out3'))).equals(big));
    // share links work from a barn too
    const link = await owner.share((await owner.list()).files.find((x) => x.id === f.id));
    assert.ok(fs.readFileSync(await fetchShared(link.url, path.join(tmp, 'out4'))).equals(big));
    // the page lets browsers reach the barn
    const page = await fetch(site + '/');
    assert.ok(page.headers.get('content-security-policy').includes(s3.url));
    // deleting leaves chores, which a device does
    await owner.remove((await owner.list()).files.find((x) => x.id === f.id));
    assert.equal(rows('SELECT COUNT(*) FROM chores')[0][0], 3);
    await owner.chores();
    assert.equal(rows('SELECT COUNT(*) FROM chores')[0][0], 0);
    assert.equal([...s3.store.keys()].filter((k) => k.includes(f.id)).length, 0);
    // a barn that still holds files can't be removed by accident
    await owner.send(file('big/keep.bin', crypto.randomBytes(100)));
    await assert.rejects(owner.http('barns', { body: { do: 'remove', id: add.id } }), /files live in this barn/);
  } finally { s3.close(); }
});

test('the console: a password, then requests and errors, for the owner only', async () => {
  await assert.rejects(laptop.http('console_login', { body: { password: 'x' }, auth: false }), /off on this site/);
  const friend = as('friend'); // someone else's nest on the same site
  await friend.enter('sam', 'samspassword', { make: true });
  await assert.rejects(friend.http('console_set', { body: { password: 'devpassword1' } }), /owner/);
  await assert.rejects(owner.http('console_set', { body: { password: 'short' } }), /8 characters/);
  await owner.http('console_set', { body: { password: 'devpassword1' } });
  await assert.rejects(laptop.http('console_login', { body: { password: 'nope-nope' }, auth: false }), /Wrong console password/);
  const { token } = await laptop.http('console_login', { body: { password: 'devpassword1' }, auth: false });
  const v = await laptop.http('console', { body: { token }, auth: false });
  assert.ok(v.rows.length > 20);
  assert.ok(v.rows.some((r) => r.a === 'list' && r.n === 'dhruv' && r.s === 200), 'it sees what was asked, after unsealing');
  assert.ok(v.rows.some((r) => r.a === 'console_login' && r.s === 403));
  assert.ok(v.rows.every((r) => !/\.\d+$/.test(r.ip)), 'addresses are cut short');
  assert.ok(v.stats.nests >= 1);
  await assert.rejects(laptop.http('console', { body: { token: 'f'.repeat(64) }, auth: false }), /Sign in to the console/);
});

test('the wire works the same in Python and in JavaScript', () => {
  // the same keys from the same handshake, and the same scrambling
  const py = spawnSync('python3', ['-c', `
import sys, json; sys.path.insert(0, sys.argv[1])
from pigeon_server import _hkdf, _stream, P
x = 0x1234567 ; y = pow(2, x, P).to_bytes(256, 'big')
k = _hkdf(b'secret', b'pigeon-wire-1', b'info', 128)
print(json.dumps({'y': y.hex(), 'k': k.hex(), 's': _stream(k[:32], bytes(16), b'hello pigeon, hello wire!' * 3).hex()}))
`, path.join(__dirname, '..', 'server')], { encoding: 'utf8' });
  const o = JSON.parse(py.stdout);
  assert.equal(W.modpow(W.G, BigInt(0x1234567), W.P).toString(16).padStart(512, '0'), o.y);
  const k = W.hkdf(Buffer.from('secret'), Buffer.from('pigeon-wire-1'), Buffer.from('info'), 128);
  assert.equal(W.hex(k), o.k);
  assert.equal(W.hex(W.stream(new W.HmacKey(k.subarray(0, 32)), new Uint8Array(16), Buffer.from('hello pigeon, hello wire!'.repeat(3)))), o.s);
});

test('server-only checks (Python): presigning, expiry, version limits, the console log', () => {
  const r = spawnSync('python3', [path.join(__dirname, 'test_server.py')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
