'use strict';
// Locking files before they leave your computer.
//
// Your password never leaves the device. It's stretched (PBKDF2-SHA256) into
// two keys: one proves to the website that it's you, the other locks your
// files and never leaves the device. Every file gets its own random key; the
// website stores only scrambled bytes, a scrambled name, and the file key
// locked with your key. A share link carries a file's key after the '#', which
// browsers never send to the website.
//
// The web page (web/index.html) does exactly the same with WebCrypto, so files
// sent from your phone open on your laptop and the other way round.

const crypto = require('crypto');

const ITERATIONS = 310000;
const CHUNK = 4 * 1024 * 1024; // bytes of file per piece
const OVERHEAD = 12 + 16; // nonce + tag per piece

const b64 = (buf) => Buffer.from(buf).toString('base64');
const unb64 = (s) => Buffer.from(String(s || ''), 'base64');
const b64url = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => unb64(String(s || '').replace(/-/g, '+').replace(/_/g, '/'));

/** Password + salt -> { proof (hex, sent to log in), key (32 bytes, stays here) }. */
function stretch(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.pbkdf2(Buffer.from(String(password), 'utf8'), unb64(salt), ITERATIONS, 64, 'sha256', (e, bits) => {
      if (e) return reject(e);
      resolve({ proof: bits.subarray(0, 32).toString('hex'), key: bits.subarray(32, 64) });
    });
  });
}

const newSalt = () => b64(crypto.randomBytes(16));
const newFileKey = () => crypto.randomBytes(32);

function seal(key, plain, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad, 'utf8'));
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
}

function open(key, box, aad) {
  box = Buffer.from(box);
  if (box.length < OVERHEAD) throw new Error('damaged');
  const d = crypto.createDecipheriv('aes-256-gcm', key, box.subarray(0, 12));
  d.setAAD(Buffer.from(aad, 'utf8'));
  d.setAuthTag(box.subarray(box.length - 16));
  try {
    return Buffer.concat([d.update(box.subarray(12, box.length - 16)), d.final()]);
  } catch {
    throw new Error("couldn't unlock this (wrong password, or the file was changed)");
  }
}

const wrapKey = (myKey, fileKey) => b64(seal(myKey, fileKey, 'pigeon/key'));
const unwrapKey = (myKey, wrapped) => open(myKey, unb64(wrapped), 'pigeon/key');
const sealMeta = (fileKey, meta) => b64(seal(fileKey, Buffer.from(JSON.stringify(meta), 'utf8'), 'pigeon/meta'));
const openMeta = (fileKey, box) => JSON.parse(open(fileKey, unb64(box), 'pigeon/meta').toString('utf8'));
const sealChunk = (fileKey, n, data) => seal(fileKey, data, 'pigeon/chunk/' + n);
const openChunk = (fileKey, n, box) => open(fileKey, box, 'pigeon/chunk/' + n);

// ── squeezing (pigeon 3): each piece is deflated first if that makes it smaller ──
// A squeezed file's label says z: 1. Its pieces start with one byte (0 = as is,
// 1 = deflated) and are locked under a different label, so an older pigeon
// refuses them instead of saving scrambled bytes.
const zlib = require('zlib');
const SKIP_SQUEEZE = /\.(jpe?g|png|gif|webp|heic|heif|avif|mp4|mov|m4v|webm|mkv|mp3|m4a|aac|ogg|opus|flac|zip|gz|tgz|bz2|xz|zst|7z|rar|dmg|pdf|docx|xlsx|pptx|key|pages|numbers|jar|apk|ipa|woff2?)$/i;
const worthSqueezing = (name) => !SKIP_SQUEEZE.test(String(name || ''));
function squeeze(buf, tryIt = true) {
  if (tryIt && buf.length >= 512) {
    const z = zlib.deflateRawSync(buf, { level: 6 });
    if (z.length <= buf.length * 0.95) return Buffer.concat([Buffer.from([1]), z]);
  }
  return Buffer.concat([Buffer.from([0]), buf]);
}
function unsqueeze(piece) {
  if (piece[0] === 0) return piece.subarray(1);
  if (piece[0] === 1) return zlib.inflateRawSync(piece.subarray(1), { maxOutputLength: CHUNK + 1024 });
  throw new Error('damaged piece');
}
const sealPiece = (fileKey, n, data, tryIt) => seal(fileKey, squeeze(data, tryIt), 'pigeon/z/' + n);
const openPiece = (fileKey, n, box) => unsqueeze(open(fileKey, box, 'pigeon/z/' + n));

// ── keys made from your nest key for one job each ──
const subKey = (key, what) => Buffer.from(crypto.hkdfSync('sha256', key, Buffer.from('pigeon'), Buffer.from(what), 32));

/** Device names are locked too: "l1:" + the name sealed with a key from your nest key. */
const sealLabel = (key, text) => 'l1:' + b64(seal(subKey(key, 'label'), Buffer.from(String(text), 'utf8'), 'pigeon/label'));
function openLabel(key, s) {
  if (!/^l1:/.test(String(s || ''))) return s || '';
  try { return open(subKey(key, 'label'), unb64(s.slice(3)), 'pigeon/label').toString('utf8'); } catch { return 'a device'; }
}

/**
 * A file's fingerprint, so the same bytes are never stored twice in your nest.
 * It's keyed with your nest key, so the website can only tell "these two of
 * yours match", never what they are or whether anyone else has them.
 */
function printOf(key, file, size) {
  const fs = require('fs');
  const parts = [Buffer.from(`pigeon-print-1:${size}:`, 'utf8')];
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.min(CHUNK, Math.max(1, size)));
    for (let at = 0; at < size || (size === 0 && at === 0); at += CHUNK) {
      const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - at), at);
      parts.push(crypto.createHash('sha256').update(buf.subarray(0, n)).digest());
      if (size === 0) break;
    }
  } finally { fs.closeSync(fd); }
  return crypto.createHmac('sha256', subKey(key, 'print')).update(Buffer.concat(parts)).digest('hex');
}

// ── drop boxes: anyone can lock a file for you with the box's public key (ECDH P-256) ──
function newBox(myKey) {
  const e = crypto.createECDH('prime256v1');
  e.generateKeys();
  const pub = e.getPublicKey();
  const priv = b64(seal(myKey, Buffer.from(JSON.stringify({ d: b64url(e.getPrivateKey()) })), 'pigeon/box'));
  return { pub: b64(pub), priv };
}
function boxSecret(myKey, priv) { return unb64url(JSON.parse(open(myKey, unb64(priv), 'pigeon/box').toString('utf8')).d); }
function dropKey(secret, ephPub, boxPub) { return Buffer.from(crypto.hkdfSync('sha256', secret, Buffer.from('pigeon/drop'), Buffer.concat([ephPub, boxPub]), 32)); }
/** Lock a file key for a drop box: [their one-time public key 65][nonce 12][key 32][tag 16]. */
function dropWrap(boxPubB64, fileKey) {
  const boxPub = unb64(boxPubB64);
  const e = crypto.createECDH('prime256v1');
  e.generateKeys();
  const ephPub = e.getPublicKey();
  const k = dropKey(e.computeSecret(boxPub), ephPub, boxPub);
  return b64(Buffer.concat([ephPub, seal(k, fileKey, 'pigeon/drop')]));
}
function dropUnwrap(myKey, box, wrapped) {
  const w = unb64(wrapped);
  const e = crypto.createECDH('prime256v1');
  e.setPrivateKey(boxSecret(myKey, box.priv));
  const ephPub = w.subarray(0, 65), boxPub = unb64(box.pub);
  return open(dropKey(e.computeSecret(ephPub), ephPub, boxPub), w.subarray(65), 'pigeon/drop');
}

module.exports = {
  ITERATIONS, CHUNK, OVERHEAD, stretch, newSalt, newFileKey, wrapKey, unwrapKey, sealMeta, openMeta, sealChunk, openChunk,
  sealPiece, openPiece, squeeze, unsqueeze, worthSqueezing, subKey, sealLabel, openLabel, printOf, newBox, dropWrap, dropUnwrap,
  b64, unb64, b64url, unb64url,
};
