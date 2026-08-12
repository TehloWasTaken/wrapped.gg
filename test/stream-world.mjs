import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { toNdjson } from '../src/build/ndjson.js';
import { buildFromStream } from '../src/build/build.js';

const [statsDir, usercachePath] = process.argv.slice(2);
if (!statsDir) {
  console.error('usage: node test/stream-world.mjs <world/stats dir> [usercache.json]');
  console.error('point it at a real server folder; nothing is bundled here.');
  process.exit(2);
}

function loadNames(path) {
  const names = {};
  if (!path) return names;
  try {
    const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
    const rows = Array.isArray(raw) ? raw : Object.entries(raw).map(([uuid, r]) => ({ uuid, ...r }));
    for (const r of rows) {
      const uuid = r.uuid || r.UUID;
      const name = r.name || r.Name || r.Gamertag;
      if (uuid && name) names[uuid] = name;
    }
  } catch (e) {
    console.error('could not read', path, '-', e.message);
  }
  return names;
}

const OUT = join(tmpdir(), 'wrapped-gg-bench.ndjson.gz');
const strip = s => s.startsWith('minecraft:') ? s.slice(10) : s;

if (!fs.existsSync(OUT)) {
  const players = {};
  const names = loadNames(usercachePath);
  for (const f of fs.readdirSync(statsDir)) {
    if (!f.endsWith('.json')) continue;
    let raw; try { raw = JSON.parse(fs.readFileSync(join(statsDir, f), 'utf8')); } catch { continue; }
    const d = {};
    for (const [cat, e] of Object.entries(raw.stats || {})) {
      const c = strip(cat);
      for (const [k, v] of Object.entries(e)) if (v) d[`${c}/${strip(k)}`] = v;
    }
    if (Object.keys(d).length) players[f.slice(0, -5)] = d;
  }
  const nd = toNdjson({ snapshot_at: Math.floor(Date.now()/1000), source: 'shell', players, names });
  fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(nd), { level: 6 }));
}

console.log('upload payload  :', (fs.statSync(OUT).size / 1048576).toFixed(2), 'MB gzipped');

if (global.gc) global.gc();
const before = process.memoryUsage();
const t0 = Date.now();

const web = Readable.toWeb(fs.createReadStream(OUT));
let emitted = 0, bytes = 0, top = null;
const res = await buildFromStream(web, { gzipped: true, onPlayer: (doc) => {
  bytes += JSON.stringify(doc).length; emitted++;
  if (!top || doc.playtime_hours > top.playtime_hours) top = { name: doc.name, playtime_hours: doc.playtime_hours, blocks_mined: doc.blocks_mined };
}});

if (global.gc) global.gc();
const after = process.memoryUsage();
console.log('build time      :', ((Date.now() - t0) / 1000).toFixed(2), 's');
console.log('players         :', emitted.toLocaleString(), '| emitted bytes', (bytes/1048576).toFixed(1),'MB');
console.log('store bytes     :', (res.store.approxBytes() / 1048576).toFixed(1), 'MB');
console.log('heapUsed delta  :', ((after.heapUsed - before.heapUsed) / 1048576).toFixed(0), 'MB');
console.log('peak rss        :', (after.rss / 1048576).toFixed(0), 'MB');
console.log('');
console.log('Workers limit   : 128 MB');
console.log('VERDICT         :', after.heapUsed / 1048576 < 100 ? 'FITS in a Worker' : 'still too big');
console.log('\nsanity: top =', top.name, top.playtime_hours+'h', '| mined', top.blocks_mined.toLocaleString());
