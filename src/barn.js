'use strict';
// Storage barns: free buckets that give a pigeon site far more room.
//
// A barn is an S3-compatible bucket: Backblaze B2 (10 GB free) or Cloudflare R2
// (10 GB free), or any other. The site's owner adds one with `pigeon barn add`;
// after that, files go from your devices straight into the bucket, locked as
// always. The site keeps the bucket's key and hands out permission slips
// (presigned URLs) that work for one piece, for an hour.
//
// Setting one up needs a computer (not a browser), once: browsers may only use
// a bucket that says so (a "CORS" rule), and only a computer can add that rule.

const http = require('http');
const https = require('https');

/** One request, with exactly the headers given (fetch adds and hides some). Resolves { status, headers, body }. */
function raw(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method, headers: { ...headers, ...(body !== undefined ? { 'content-length': Buffer.byteLength(body) } : {}) }, timeout: 30000 }, (res) => {
      const parts = [];
      res.on('data', (d) => parts.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('it took too long')));
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The provider's error, in a line: <Code>SignatureDoesNotMatch</Code><Message>…</Message> → "SignatureDoesNotMatch: …". */
function why(r) {
  const code = /<Code>([^<]+)<\/Code>/.exec(r.body || '');
  const msg = /<Message>([^<]+)<\/Message>/.exec(r.body || '');
  return `${r.status}${code ? ' ' + code[1] : ''}${msg ? ': ' + msg[1] : ''}`;
}

/**
 * Set up and test a barn with the permission slips the site made (setup from
 * `barns add` or `barns fix`). say(text) reports each step. Resolves
 * { works, cors, signlen, note }.
 */
async function check(setup, say = () => {}) {
  const out = { works: false, cors: false, signlen: true, note: '' };
  // 1. the CORS rule, so browsers (your phone, the website) can use the bucket
  try {
    const r = await raw(setup.cors.url, { method: 'PUT', headers: { 'content-md5': setup.cors.md5, 'content-type': 'application/xml' }, body: setup.cors.xml });
    say(r.status < 300 ? 'Let browsers use it (CORS rule): done' : `Let browsers use it (CORS rule): the bucket said ${why(r)}`);
  } catch (e) { say(`Let browsers use it (CORS rule): couldn't reach it (${e.code || e.message})`); }
  // ...and see whether browsers are really allowed now
  try {
    const r = await raw(`${setup.origin}/${setup.bucket}/pigeon/.hello`, { method: 'OPTIONS', headers: { origin: 'https://pigeon.example', 'access-control-request-method': 'PUT', 'access-control-request-headers': 'content-type' } });
    out.cors = r.status < 300 && !!r.headers['access-control-allow-origin'];
  } catch { out.cors = false; }
  say(out.cors ? 'Browsers allowed: yes' : 'Browsers allowed: not yet');
  // 2. a tiny test file: in, out, gone
  try {
    let r = await raw(setup.put, { method: 'PUT', body: setup.body });
    if (r.status === 403) { // some buckets don't like a signed size: try without
      const r2 = await raw(setup.putPlain, { method: 'PUT', body: setup.body });
      if (r2.status < 300) { out.signlen = false; r = r2; }
    }
    if (r.status >= 300) { out.note = `Sending a test file failed: ${why(r)}`; say(out.note); return out; }
    say('Send a test file: done');
    const g = await raw(setup.get);
    if (g.status >= 300 || g.body !== setup.body) { out.note = `Reading it back failed: ${why(g)}`; say(out.note); return out; }
    say('Read it back: done');
    const d = await raw(setup.del, { method: 'DELETE' });
    if (d.status >= 300 && d.status !== 404) { out.note = `Deleting it failed: ${why(d)}`; say(out.note); return out; }
    say('Delete it: done');
    out.works = true;
  } catch (e) { out.note = `Couldn't reach the bucket (${e.code || e.message})`; say(out.note); }
  if (out.works && !out.cors) out.note = "It works from computers, but browsers aren't allowed in yet: add the CORS rule by hand (pigeon barn guide), then run pigeon barn fix";
  return out;
}

const CORS_JSON = '[{"AllowedOrigins":["*"],"AllowedMethods":["GET","PUT","DELETE","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3600}]';

/** Step-by-step, for someone who has never made a bucket. */
const GUIDE = {
  b2: {
    name: 'Backblaze B2 (10 GB free)',
    needs: 'an email address, and a phone that can get one text message (SMS) to turn B2 on. A parent\'s phone works. No credit card.',
    steps: [
      'Go to backblaze.com/sign-up/cloud-storage and make an account (email and password).',
      'Turn on B2 when it asks: it sends a code to a phone by text message. Type the code in.',
      'In the menu on the left, click Buckets, then Create a Bucket. Give it a name nobody else has used, like pigeon-dhruv-2026. Leave "Files in Bucket are" on Private. Click Create a Bucket.',
      'On the new bucket, find "Endpoint". It looks like s3.us-east-005.backblazeb2.com. Copy it.',
      'In the menu on the left, click Application Keys, then Add a New Application Key. Name: pigeon. Allow access to: your new bucket. Type of access: Read and Write. Click Create New Key.',
      'Copy the keyID and the applicationKey straight away (the applicationKey is shown only once).',
      'In Terminal, type: pigeon barn add   and paste the endpoint, bucket name, keyID and applicationKey when it asks.',
    ],
    cors: 'If browsers aren\'t allowed yet: open the bucket, click CORS Rules, pick "Share everything in this bucket with all HTTPS origins", tick "Apply CORS rules to the following S3 Compatible API" too, and Save. Then: pigeon barn fix',
  },
  r2: {
    name: 'Cloudflare R2 (10 GB free each month)',
    needs: 'an email address, and a payment method on the account (Cloudflare asks for one before the first bucket, even for the free part). pigeon keeps the barn under 10 GB so nothing is charged, but a grown-up should know about the card.',
    steps: [
      'Go to dash.cloudflare.com/sign-up and make an account.',
      'In the menu on the left, click R2 Object Storage. Add a payment method if it asks, then Create bucket. Give it a name, like pigeon. Location: Automatic. Click Create bucket.',
      'Back on the R2 page, copy your Account ID (on the right side). It\'s 32 letters and numbers.',
      'Click Manage R2 API Tokens (or API > Manage API tokens), then Create API token. Permissions: Object Read & Write. Apply to: only your new bucket. Click Create.',
      'Copy the Access Key ID and the Secret Access Key straight away (the secret is shown only once).',
      'In Terminal, type: pigeon barn add   and paste the Account ID, bucket name, Access Key ID and Secret Access Key when it asks.',
    ],
    cors: `If browsers aren't allowed yet: open the bucket, go to Settings, CORS Policy, Add CORS policy, paste this and Save:\n    ${CORS_JSON}\n  Then: pigeon barn fix`,
  },
};

module.exports = { check, raw, why, GUIDE, CORS_JSON };
