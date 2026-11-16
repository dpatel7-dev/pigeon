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

module.exports = {
  ITERATIONS, CHUNK, OVERHEAD, stretch, newSalt, newFileKey, wrapKey, unwrapKey, sealMeta, openMeta, sealChunk, openChunk,
  b64, unb64, b64url, unb64url,
};
