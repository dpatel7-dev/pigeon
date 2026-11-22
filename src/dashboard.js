'use strict';
// `pigeon dashboard`: your nest in your browser, served from this computer.
//
// It's the same page as the website's, but already logged in (as this
// computer), and "Save" writes straight into a folder here instead of going
// through the browser's downloads. Everything still travels locked: this little
// server only passes the website's answers along, and listens on 127.0.0.1 with
// a secret address, so nothing else on the network can reach it.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Nest, downloads, free, safeName, home } = require('./nest');
const { open: openThing } = require('./tui');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const Look = require('./look');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

function page(nest, base, saveDir) {
  const conf = {
    base: `${base}/p`, origin: '', site: nest.site, version: pkg.version,
    sh: `${nest.site}/install.sh`, ps1: `${nest.site}/install.ps1`,
    local: { saveTo: saveDir.replace(os.homedir(), '~'), device: require('./nest').device() },
    wire: nest.wireKey || ((require('./nest').session.load().pins || {})[nest.site]) || undefined,
    session: { nest: nest.name, token: nest.token, key: nest.key.toString('base64'), did: nest.did },
  };
  return read('web', 'index.html')
    .replace('/*PIGEON_CONFIG*/{}', JSON.stringify(conf).replace(/</g, '\\u003c'))
    .replace('/*PIGEON_QR*/', read('src', 'qr.js').replace(/<\/script/g, '<\\/script'))
    .replace('/*PIGEON_WIRE*/', read('src', 'wire.js').replace(/<\/script/g, '<\\/script'))
    .replace('/*PIGEON_DIFF*/', read('src', 'diff.js').replace(/<\/script/g, '<\\/script'));
}

/** Start it. Resolves with { url, close }. */
function serve({ port = 0, saveDir = downloads(), openBrowser = true } = {}) {
  const nest = new Nest();
  if (!nest.in) return Promise.reject(new Error('Log in first: pigeon login'));
  const secret = crypto.randomBytes(12).toString('hex');
  const base = `/${secret}`;
  const server = http.createServer(async (req, res) => {
    const host = req.headers.host || '';
    const addr = server.address();
    if (host !== `127.0.0.1:${addr.port}` && host !== `localhost:${addr.port}`) { res.writeHead(403); return res.end(); } // no DNS tricks
    const url = new URL(req.url, `http://${host}`);
    if (!url.pathname.startsWith(base)) { res.writeHead(404); return res.end('not here'); }
    const rest = url.pathname.slice(base.length) || '/';
    try {
      if (rest === '/' && req.method === 'GET') {
        const n = new Nest();
        await n.connect().catch(() => {});
        const html = Look.inject(page(n, base, saveDir), Look.read(), base + '/__look');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
        return res.end(html);
      }
      if (rest === '/__look' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify({ look: Look.read() })); } // light or dark, set in pca
      if (rest.startsWith('/p/api')) return proxy(nest, req, res, rest.slice(2) + url.search);
      if (rest === '/local/save' && req.method === 'POST') {
        const dir = path.join(saveDir, ...(url.searchParams.get('path') || '').split('/').filter(Boolean).map(safeName));
        fs.mkdirSync(dir, { recursive: true });
        const where = free(path.join(dir, safeName(url.searchParams.get('name') || 'file')));
        const out = fs.createWriteStream(where);
        req.pipe(out);
        out.on('finish', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ where: where.replace(os.homedir(), '~') })); });
        out.on('error', (e) => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
        return;
      }
      if (rest === '/local/open' && req.method === 'POST') { openThing(saveDir); res.writeHead(200); return res.end('{}'); }
      res.writeHead(404); res.end('not here');
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://127.0.0.1:${server.address().port}${base}/`;
      try { fs.writeFileSync(path.join(home(), 'dashboard.url'), url + '\n', { mode: 0o600 }); } catch { /* fine */ }
      if (openBrowser) openThing(url);
      resolve({ url, close: () => server.close() });
    });
  });
}

/** Pass a request to the website and its answer back. */
function proxy(nest, req, res, apiPath) {
  const target = new URL(nest.site + apiPath);
  const lib = target.protocol === 'https:' ? require('https') : http;
  const headers = {};
  for (const h of ['authorization', 'content-type', 'content-length']) if (req.headers[h]) headers[h] = req.headers[h];
  const up = lib.request(target, { method: req.method, headers, timeout: 180000 }, (r) => {
    const out = { 'cache-control': 'no-store' };
    if (r.headers['content-type']) out['content-type'] = r.headers['content-type'];
    if (r.headers['content-length']) out['content-length'] = r.headers['content-length'];
    res.writeHead(r.statusCode || 502, out);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timed out')));
  up.on('error', (e) => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: `Couldn't reach ${nest.site.replace(/^https?:\/\//, '')} (${e.code || e.message}).` }));
  });
  req.pipe(up);
}

module.exports = { serve };
