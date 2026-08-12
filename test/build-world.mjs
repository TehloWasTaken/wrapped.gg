import fs from 'node:fs';
import { buildWrapped } from '../src/build/build.js';

const [statsDir, usercachePath] = process.argv.slice(2);
if (!statsDir) {
  console.error('usage: node test/build-world.mjs <world/stats dir> [usercache.json]');
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

const strip = s => s.startsWith('minecraft:') ? s.slice(10) : s;

function loadCanonical(dir) {
  const players = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let raw; try { raw = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch { continue; }
    const d = {};
    for (const [cat, e] of Object.entries(raw.stats || {})) {
      const c = strip(cat);
      for (const [k, v] of Object.entries(e)) if (v) d[`${c}/${strip(k)}`] = v;
    }
    if (Object.keys(d).length) players[f.slice(0, -5)] = d;
  }
  return { v: 1, snapshot_at: Math.floor(Date.now() / 1000), players };
}

const t0 = Date.now();
const payload = loadCanonical(statsDir);
const parsed = Date.now();

const names = loadNames(usercachePath);

const res = buildWrapped(payload, null, { names, collect: true });
const done = Date.now();
const mem = process.memoryUsage();

console.log('parse payload   :', ((parsed - t0) / 1000).toFixed(2), 's');
console.log('build           :', ((done - parsed) / 1000).toFixed(2), 's');
console.log('players out     :', res.players.length.toLocaleString());
console.log('store bytes     :', (res.store.approxBytes() / 1048576).toFixed(1), 'MB');
console.log('heapUsed        :', (mem.heapUsed / 1048576).toFixed(0), 'MB');
console.log('rss             :', (mem.rss / 1048576).toFixed(0), 'MB');

const top = res.players.slice().sort((a, b) => b.playtime_hours - a.playtime_hours)[0];
console.log('\ntop player      :', top.name, '|', top.playtime_hours, 'h |', top.platform);
console.log('  rank.playtime :', JSON.stringify(top.rank.playtime));
console.log('  blocks mined  :', top.blocks_mined.toLocaleString(), '| mobs:', top.mobs_killed.toLocaleString());
console.log('  distance km   :', top.distance.total_km);
console.log('  top_mined     :', top.top_mined.slice(0,2).map(r=>`${r.label}(${r.sprite})`).join(', '));
console.log('  signature     :', top.signature_award && `${top.signature_award.title} #${top.signature_award.rank}/${top.signature_award.of}`);
console.log('  awards        :', top.awards.length);
const bed = res.players.filter(p => p.platform === 'bedrock');
console.log('\nbedrock players :', bed.length.toLocaleString(), bed[0] ? `(e.g. ${bed[0].name})` : '');
console.log('server totals   : mined', res.server.blocks_mined.toLocaleString(),
            '| killed', res.server.mobs_killed.toLocaleString(),
            '| hours', res.server.playtime_hours.toLocaleString());
