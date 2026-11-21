'use strict';
// Keep a copy of your nest in a folder on this computer (like Google Drive's
// desktop app, kept simple):
//   - files in your nest that aren't in the folder yet are downloaded
//   - new files you put in the folder are uploaded (changed ones become a new version: Rewind keeps the old)
//   - nothing is ever deleted on either side: deleting stays a decision you make
// What's been matched up is remembered in ~/.pigeon/sync.json.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { home, free, safeName, pathKey, SKIP } = require('./nest');

const stateFile = () => path.join(home(), 'sync.json');
function load() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } }
function save(all) { fs.mkdirSync(home(), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(all, null, 1)); }

const defaultRoot = () => path.join(os.homedir(), 'Pigeon');
const skipped = (name) => name.startsWith('.') || SKIP.some((s) => (s.startsWith('*') ? name.endsWith(s.slice(1)) : name === s)) || name.endsWith('.pigeon-part');

function walk(root, rel = '', out = [], skipDirs = new Set()) {
  let list = [];
  try { list = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const d of list) {
    if (skipped(d.name)) continue;
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) { if (!skipDirs.has(r)) walk(root, r, out, skipDirs); }
    else if (d.isFile()) out.push(r);
  }
  return out;
}

/**
 * One round. onEvent({ kind: 'down'|'up'|'skip'|'error', name, where, error }).
 * up: false keeps it one-way (only downloads).
 */
async function syncOnce(nest, root = defaultRoot(), { up = true, onEvent = () => {}, onProgress = () => {} } = {}) {
  root = path.resolve(root);
  fs.mkdirSync(root, { recursive: true });
  const all = load();
  const key = `${nest.site}|${nest.name}|${root}`;
  const st = all[key] || { byId: {}, byPath: {} };
  const { files } = await nest.list();
  const live = files.filter((f) => f.done && !f.trashed && f.fileKey && f.kind !== 'dir');
  const counts = { down: 0, up: 0 };

  // folders first, so empty ones show up too
  for (const f of files) {
    if (f.kind !== 'dir' || f.trashed) continue;
    fs.mkdirSync(path.join(root, ...[...f.meta.path, f.meta.name].map(safeName)), { recursive: true });
  }
  // 1. down: anything not here yet
  for (const f of live) {
    const known = st.byId[f.id];
    if (known && fs.existsSync(path.join(root, known))) continue;
    const dir = path.join(root, ...f.meta.path.map(safeName));
    try {
      const where = await nest.get(f, dir, { onProgress: (d, t) => onProgress(f.meta.name, d, t) });
      const rel = path.relative(root, where).split(path.sep).join('/');
      const s = fs.statSync(where);
      st.byId[f.id] = rel;
      st.byPath[rel] = { id: f.id, size: s.isFile() ? s.size : 0, mtime: s.mtimeMs, bundle: s.isDirectory() || undefined };
      counts.down++;
      onEvent({ kind: 'down', name: f.meta.name, where });
    } catch (e) { onEvent({ kind: 'error', name: f.meta.name, error: e.message }); }
  }
  // 2. up: new or changed files in the folder
  if (up) {
    const byId = new Map(live.map((f) => [f.id, f]));
    let known = files;
    const bundles = new Set(Object.keys(st.byPath).filter((r) => st.byPath[r].bundle)); // project folders that came as one bundle stay one
    for (const rel of walk(root, '', [], bundles)) {
      const full = path.join(root, ...rel.split('/'));
      let s;
      try { s = fs.statSync(full); } catch { continue; }
      const rec = st.byPath[rel];
      if (rec && rec.size === s.size && Math.abs(rec.mtime - s.mtimeMs) < 2000) continue;
      const folder = rel.split('/').slice(0, -1);
      try {
        if (folder.length) { await nest.mkdir(folder, known); known = (await nest.list()).files; }
        // a changed file becomes a new version: the older one is kept in Rewind (pigeon rewind <name>)
        const r = await nest.send(full, { folder, replaces: rec && byId.has(rec.id) ? rec.id : undefined, onProgress: (d, t) => onProgress(path.basename(rel), d, t) });
        st.byId[r.id] = rel;
        st.byPath[rel] = { id: r.id, size: s.size, mtime: s.mtimeMs };
        counts.up++;
        onEvent({ kind: 'up', name: rel, where: full });
      } catch (e) { onEvent({ kind: 'error', name: rel, error: e.message }); }
    }
  }
  all[key] = st;
  save(all);
  return counts;
}

module.exports = { syncOnce, defaultRoot, walk };
