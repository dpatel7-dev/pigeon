'use strict';
// A pretend S3 bucket for the tests: it checks presigned URLs the way S3 does
// (AWS Signature Version 4, written here separately from the server's signer),
// keeps objects in memory, and answers CORS preflights once a rule is set.

const http = require('http');
const crypto = require('crypto');

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

function start({ akid, secret, bucket, region = 'us-east-1' }) {
  const store = new Map();
  const state = { cors: null, requests: [] };
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      const body = Buffer.concat(parts);
      const u = new URL(req.url, 'http://x');
      state.requests.push(`${req.method} ${u.pathname}`);
      const corsHeaders = state.cors ? { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, PUT, DELETE, HEAD', 'access-control-allow-headers': '*' } : {};
      const fail = (status, code) => { res.writeHead(status, { 'content-type': 'application/xml', ...corsHeaders }); res.end(`<Error><Code>${code}</Code><Message>${code}</Message></Error>`); };
      if (req.method === 'OPTIONS') { res.writeHead(state.cors ? 200 : 403, corsHeaders); return res.end(); }
      // check the signature
      const q = u.searchParams;
      const sig = q.get('X-Amz-Signature');
      if (!sig) return fail(403, 'AccessDenied');
      const [id, day, reg, svc] = (q.get('X-Amz-Credential') || '').split('/');
      if (id !== akid || reg !== region || svc !== 's3') return fail(403, 'InvalidAccessKeyId');
      const amz = q.get('X-Amz-Date');
      const t = Date.UTC(+amz.slice(0, 4), +amz.slice(4, 6) - 1, +amz.slice(6, 8), +amz.slice(9, 11), +amz.slice(11, 13), +amz.slice(13, 15));
      if (Date.now() > t + Number(q.get('X-Amz-Expires')) * 1000) return fail(403, 'AccessDenied');
      const signed = q.get('X-Amz-SignedHeaders').split(';');
      const canonQuery = [...q.entries()].filter(([k]) => k !== 'X-Amz-Signature').map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
      const canonHeaders = signed.map((h) => `${h}:${String(req.headers[h] || '').trim()}\n`).join('');
      const creq = [req.method, u.pathname, canonQuery, canonHeaders, signed.join(';'), 'UNSIGNED-PAYLOAD'].join('\n');
      const scope = `${day}/${region}/s3/aws4_request`;
      const sts = ['AWS4-HMAC-SHA256', amz, scope, crypto.createHash('sha256').update(creq).digest('hex')].join('\n');
      let k = hmac('AWS4' + secret, day);
      for (const p of [region, 's3', 'aws4_request']) k = hmac(k, p);
      if (hmac(k, sts).toString('hex') !== sig) return fail(403, 'SignatureDoesNotMatch');
      const path = decodeURIComponent(u.pathname);
      if (!path.startsWith(`/${bucket}`)) return fail(404, 'NoSuchBucket');
      const key = path.slice(bucket.length + 2);
      if (q.has('cors') && req.method === 'PUT') {
        if (crypto.createHash('md5').update(body).digest('base64') !== req.headers['content-md5']) return fail(400, 'BadDigest');
        state.cors = body.toString();
        res.writeHead(200); return res.end();
      }
      if (req.method === 'PUT') { store.set(key, body); res.writeHead(200, { etag: '"x"', ...corsHeaders }); return res.end(); }
      if (req.method === 'GET') { if (!store.has(key)) return fail(404, 'NoSuchKey'); res.writeHead(200, { 'content-type': 'application/octet-stream', ...corsHeaders }); return res.end(store.get(key)); }
      if (req.method === 'DELETE') { store.delete(key); res.writeHead(204, corsHeaders); return res.end(); }
      return fail(405, 'MethodNotAllowed');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, store, state, close: () => server.close() })));
}

module.exports = { start };
