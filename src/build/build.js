import STAT_DEFS from './stats.js';
import { platformOf, dashless } from '../lib/util.js';
import { storeFromPayload, CounterStore } from './columnar.js';
import { readNdjson, gunzipStream, maybeGunzipStream } from './ndjson.js';

const nf = (n) => Number(n).toLocaleString('en-US');
const pretty = (id) => String(id).split(':').pop()
  .split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

const safeId = (id) => /^[a-z0-9_]{1,64}$/.test(id) ? id : null;

const DIST_KEYS = {
  walk: 'custom/walk_one_cm', sprint: 'custom/sprint_one_cm', swim: 'custom/swim_one_cm',
  boat: 'custom/boat_one_cm', elytra: 'custom/aviate_one_cm', minecart: 'custom/minecart_one_cm',
  horse: 'custom/horse_one_cm', fall: 'custom/fall_one_cm', climb: 'custom/climb_one_cm',
  crouch: 'custom/crouch_one_cm', pig: 'custom/pig_one_cm', strider: 'custom/strider_one_cm',
};

const GAUGES = new Set(['custom/time_since_death', 'custom/time_since_rest']);

const CATEGORY_ICON = {
  mined: 'mine_stone', killed: 'kill_any', killed_by: 'death',
  crafted: 'craft_tools', used: 'break_tools', picked_up: 'open_container',
  broken: 'break_tools',
};

function compileDefs(store) {
  const compiled = [];
  for (const d of STAT_DEFS) {
    if (d.type === 'int') {
      const id = store.keyIdOf(`${d.cat}/${d.key}`);
      if (id === undefined) continue;
      compiled.push({ ...d, keyIds: new Set([id]) });
    } else {
      const literal = new Set(), regex = [];
      for (const p of d.pats || []) {
        if (/[.*+?^${}()|[\]\\]/.test(p)) regex.push(new RegExp('^' + p + '$'));
        else literal.add(p);
      }
      const keyIds = new Set();
      const prefix = d.cat + '/';
      for (let i = 0; i < store.keys.length; i++) {
        const k = store.keys[i];
        if (!k.startsWith(prefix)) continue;
        const leaf = k.slice(prefix.length);
        if (literal.has(leaf) || regex.some(r => r.test(leaf))) keyIds.add(i);
      }
      if (keyIds.size) compiled.push({ ...d, keyIds });
    }
  }
  return compiled;
}

function buildIconIndex(store) {
  const exact = new Map(), fuzzy = [];
  for (const d of STAT_DEFS) {
    if (d.type === 'int') exact.set(`${d.cat}/${d.key}`, d.id);
    else for (const p of d.pats || []) {
      if (/[.*+?^${}()|[\]\\]/.test(p)) fuzzy.push([d.cat, new RegExp('^' + p + '$'), d.id]);
      else if (!exact.has(`${d.cat}/${p}`)) exact.set(`${d.cat}/${p}`, d.id);
    }
  }
  return (cat, key) => {
    const hit = exact.get(`${cat}/${key}`);
    if (hit) return hit;
    for (const [c, re, id] of fuzzy) if (c === cat && re.test(key)) return id;
    return CATEGORY_ICON[cat] || null;
  };
}

function rankTable(values) {
  const n = values.length;
  const order = [];
  let total = 0, count = 0;
  for (let p = 0; p < n; p++) {
    if (values[p] > 0) { order.push(p); total += values[p]; count += 1; }
  }
  order.sort((a, b) => values[b] - values[a]);
  const avg = count ? total / count : 0;
  const rank = new Int32Array(n).fill(0);
  order.forEach((p, i) => { rank[p] = i + 1; });
  return { rank, of: order.length, avg, order };
}

const rankInfo = (t, values, p) => {
  if (!t || !t.rank[p]) return null;
  const v = values[p];
  return {
    value: v,
    rank: t.rank[p],
    of: t.of,
    top_percent: Number(((t.rank[p] / t.of) * 100).toFixed(1)),
    x_avg: t.avg > 0 ? Number((v / t.avg).toFixed(1)) : null,
  };
};

export const RANK_METRICS = [
  { key: 'playtime', label: 'Hours played',       good: true },
  { key: 'mined',    label: 'Blocks mined',       good: true },
  { key: 'killed',   label: 'Mobs killed',        good: true },
  { key: 'crafted',  label: 'Items crafted',      good: true },
  { key: 'used',     label: 'Items used',         good: true },
  { key: 'distance', label: 'Distance travelled', good: true },
  { key: 'deaths',   label: 'Deaths',             good: false },
  { key: 'jumps',    label: 'Jumps',              good: true },
  { key: 'damage',   label: 'Damage dealt',       good: true },
];
export const RANK_METRIC_KEYS = RANK_METRICS.map(m => m.key);
const RANK_METRIC_INDEX = new Map(RANK_METRICS.map((m, i) => [m.key, i]));

const MAX_MOVES = 6;

function withPrevious(info, key, prevVec) {
  if (!info || !prevVec) return info;
  const was = prevVec[RANK_METRIC_INDEX.get(key)] | 0;
  if (was) { info.was = was; info.moved = was - info.rank; }
  return info;
}

function movementFor(prevVec, vec, since) {
  if (!prevVec) return null;
  const moves = [], entered = [];
  let climbed = 0, fell = 0;

  for (let i = 0; i < RANK_METRICS.length; i++) {
    const m = RANK_METRICS[i];
    const rank = vec[i] | 0, was = prevVec[i] | 0;
    if (!rank) continue;
    if (!was) { entered.push({ key: m.key, label: m.label, rank }); continue; }
    const moved = was - rank;
    if (!moved) continue;
    if (moved > 0) climbed += moved; else fell += -moved;
    moves.push({ key: m.key, label: m.label, good: m.good, rank, was, moved });
  }
  if (!moves.length && !entered.length) return null;

  moves.sort((a, b) => Math.abs(b.moved) - Math.abs(a.moved) || a.rank - b.rank);

  const best = moves.find(m => m.moved > 0 && m.good)
            || moves.find(m => m.moved > 0)
            || moves[0];

  return { since: since || null, climbed, fell, best,
           moves: moves.slice(0, MAX_MOVES), entered: entered.slice(0, MAX_MOVES) };
}

export async function buildFromStream(stream, { gzipped = null, baseline = null, onPlayer = null, collect = false, onStage = null, previous = null, onRanks = null, blocked = null } = {}) {
  const store = new CounterStore();
  const names = {};
  let header = null;
  let skipped = 0;

  const body = gzipped === null ? await maybeGunzipStream(stream)
             : gzipped ? gunzipStream(stream) : stream;

  const blockedFlat = blocked && blocked.size
    ? new Set([...blocked].map(dashless)) : null;

  await readNdjson(body, {
    onHeader: (h) => { header = h; },
    onPlayer: (row) => {
      if (!row || typeof row.u !== 'string') return;
      if (!/^[0-9a-fA-F-]{16,48}$/.test(row.u)) return;
      if (blockedFlat && blockedFlat.has(dashless(row.u))) { skipped += 1; return; }
      if (!store.addPlayer(row.u, row.c || {})) return;
      if (row.n) names[row.u] = String(row.n).slice(0, 32);
    },
  });
  store.freeze();

  if (onStage) await onStage('ranking', {
    players: store.uuids.length, entries: store.idx.length, keys: store.keys.length,
  });

  const built = buildFromStore(store, baseline, {
    onPlayer, collect, previous, onRanks,
    names,
    snapshot_at: header && header.snapshot_at,
  });
  built.skipped = skipped;
  return built;
}

export function buildWrapped(latest, baseline, opts = {}) {
  return buildFromStore(storeFromPayload(latest),
                        baseline ? storeFromPayload(baseline) : null, opts);
}

export function buildFromStore(store, base, opts = {}) {
  const windowed = base ? subtract(store, base) : store;

  const defs = compileDefs(windowed);
  const iconOf = buildIconIndex(windowed);
  const names = opts.names || {};
  const n = windowed.playerCount;

  const prefixIds = {
    mined: windowed.idsWithPrefix('mined/'),
    killed: windowed.idsWithPrefix('killed/'),
    crafted: windowed.idsWithPrefix('crafted/'),
    used: windowed.idsWithPrefix('used/'),
  };
  const kPlay = windowed.keyIdOf('custom/play_time');
  const kDeaths = windowed.keyIdOf('custom/deaths');
  const kJump = windowed.keyIdOf('custom/jump');
  const kDmg = windowed.keyIdOf('custom/damage_dealt');
  const distIds = Object.entries(DIST_KEYS)
    .filter(([m]) => m !== 'fall')
    .map(([, k]) => windowed.keyIdOf(k)).filter(x => x !== undefined);

  const metrics = {
    playtime: new Float64Array(n), mined: new Float64Array(n),
    killed: new Float64Array(n), crafted: new Float64Array(n),
    used: new Float64Array(n), distance: new Float64Array(n),
    deaths: new Float64Array(n), jumps: new Float64Array(n),
    damage: new Float64Array(n),
  };
  const distSet = new Set(distIds);
  for (let p = 0; p < n; p++) {
    const s = windowed.rowStart[p], e = windowed.rowStart[p + 1];
    for (let i = s; i < e; i++) {
      const kid = windowed.idx[i], v = windowed.val[i];
      if (kid === kPlay) metrics.playtime[p] = v;
      else if (kid === kDeaths) metrics.deaths[p] = v;
      else if (kid === kJump) metrics.jumps[p] = v;
      else if (kid === kDmg) metrics.damage[p] = v;
      if (prefixIds.mined.has(kid)) metrics.mined[p] += v;
      else if (prefixIds.killed.has(kid)) metrics.killed[p] += v;
      else if (prefixIds.crafted.has(kid)) metrics.crafted[p] += v;
      else if (prefixIds.used.has(kid)) metrics.used[p] += v;
      if (distSet.has(kid)) metrics.distance[p] += v;
    }
  }
  const ranks = {};
  for (const k in metrics) ranks[k] = rankTable(metrics[k]);

  const keyToDefs = new Map();
  defs.forEach((def, di) => {
    for (const kid of def.keyIds) {
      let arr = keyToDefs.get(kid);
      if (!arr) { arr = []; keyToDefs.set(kid, arr); }
      arr.push(di);
    }
  });

  const defVals = defs.map(() => new Float64Array(n));
  const defUsed = new Uint8Array(defs.length);
  for (let p = 0; p < n; p++) {
    const s = windowed.rowStart[p], e = windowed.rowStart[p + 1];
    for (let i = s; i < e; i++) {
      const targets = keyToDefs.get(windowed.idx[i]);
      if (!targets) continue;
      const v = windowed.val[i];
      for (let t = 0; t < targets.length; t++) {
        defVals[targets[t]][p] += v;
        defUsed[targets[t]] = 1;
      }
    }
  }

  const awardValues = new Map();
  const awardRanks = new Map();
  defs.forEach((def, di) => {
    if (!defUsed[di]) return;
    awardValues.set(def.id, defVals[di]);
    awardRanks.set(def.id, rankTable(defVals[di]));
  });
  const defById = new Map(defs.map(d => [d.id, d]));

  const players = opts.collect ? [] : null;
  const onPlayer = opts.onPlayer || null;
  const onRanks = opts.onRanks || null;
  const prevRanks = (opts.previous && opts.previous.ranks) || null;
  const prevAt = (opts.previous && opts.previous.at) || null;
  const nameByIndex = new Array(n);
  for (let p = 0; p < n; p++) {
    const uuid = windowed.uuids[p];
    const nameRec = names[uuid];
    const name = typeof nameRec === 'string' ? nameRec : (nameRec && nameRec.name) || null;

    const distance = {};
    let distTotal = 0;
    for (const [mode, key] of Object.entries(DIST_KEYS)) {
      const km = windowed.get(p, windowed.keyIdOf(key)) / 100000;
      if (km > 0) { distance[mode] = Number(km.toFixed(2)); if (mode !== 'fall') distTotal += km; }
    }
    distance.total_km = Number(distTotal.toFixed(2));

    const awards = [];
    for (const [id, vals] of awardValues) {
      if (!vals[p]) continue;
      const t = awardRanks.get(id), d = defById.get(id);
      awards.push({
        id, title: d.title, desc: d.desc, unit: d.unit,
        value: vals[p], rank: t.rank[p], of: t.of,
      });
    }
    awards.sort((a, b) => (a.rank - b.rank) || (b.of - a.of) || (b.value - a.value));

    const withIcons = (rows, cat, alt) => rows.map(r => ({
      ...r,
      label: pretty(r.id),
      icon: iconOf(cat, r.id) || (alt ? iconOf(alt, r.id) : null),
      sprite: safeId(r.id),
    }));

    const rankVec = new Array(RANK_METRICS.length);
    for (let i = 0; i < RANK_METRICS.length; i++) {
      const t = ranks[RANK_METRICS[i].key];
      rankVec[i] = t ? t.rank[p] : 0;
    }
    if (onRanks) onRanks(uuid, rankVec);

    const prevVec = prevRanks ? prevRanks.get(uuid) : null;
    const movement = movementFor(prevVec, rankVec, prevAt);
    const rk = (key, t, values) => withPrevious(rankInfo(t, values, p), key, prevVec);

    nameByIndex[p] = name;
    const doc = {
      uuid, name,
      platform: platformOf(uuid),
      playtime_hours: Number((metrics.playtime[p] / 20 / 3600).toFixed(1)),
      playtime_minutes: Number((metrics.playtime[p] / 20 / 60).toFixed(1)),
      sessions: windowed.get(p, windowed.keyIdOf('custom/leave_game')),
      deaths: metrics.deaths[p],
      blocks_mined: metrics.mined[p],
      mobs_killed: metrics.killed[p],
      items_crafted: metrics.crafted[p],
      items_used: metrics.used[p],
      jumps: metrics.jumps[p],
      damage_dealt: metrics.damage[p],
      damage_taken: windowed.get(p, windowed.keyIdOf('custom/damage_taken')),
      trades: windowed.get(p, windowed.keyIdOf('custom/traded_with_villager')),
      chests_opened: windowed.get(p, windowed.keyIdOf('custom/open_chest')),
      enchants: windowed.get(p, windowed.keyIdOf('custom/enchant_item')),
      animals_bred: windowed.get(p, windowed.keyIdOf('custom/animals_bred')),
      times_slept: windowed.get(p, windowed.keyIdOf('custom/sleep_in_bed')),
      tools_broken: windowed.sumPrefix(p, windowed.idsWithPrefix('broken/')),
      items_picked_up: windowed.sumPrefix(p, windowed.idsWithPrefix('picked_up/')),
      distance,
      rank: {
        playtime: rk('playtime', ranks.playtime, metrics.playtime),
        mined: rk('mined', ranks.mined, metrics.mined),
        killed: rk('killed', ranks.killed, metrics.killed),
        crafted: rk('crafted', ranks.crafted, metrics.crafted),
        used: rk('used', ranks.used, metrics.used),
        distance: rk('distance', ranks.distance, metrics.distance),
        deaths: rk('deaths', ranks.deaths, metrics.deaths),
        jumps: rk('jumps', ranks.jumps, metrics.jumps),
        damage: rk('damage', ranks.damage, metrics.damage),
      },
      movement,
      top_mined: withIcons(windowed.topWithin(p, 'mined/', 5), 'mined'),
      top_killed: withIcons(windowed.topWithin(p, 'killed/', 5), 'killed'),
      top_crafted: withIcons(windowed.topWithin(p, 'crafted/', 5), 'crafted'),
      top_used: withIcons(windowed.topWithin(p, 'used/', 5), 'used'),
      nemesis: withIcons(windowed.topWithin(p, 'killed_by/', 3), 'killed_by', 'killed'),
      awards: awards.slice(0, 10),
      signature_award: signatureOf(awards),
    };
    if (onPlayer) onPlayer(doc, p);
    if (players) players.push(doc);
  }

  const server = summarise(windowed, metrics, ranks, nameByIndex, iconOf,
                           { ranks: prevRanks, at: prevAt });
  return { players, server, store: windowed, count: n };
}

function signatureOf(list) {
  if (!list.length) return null;
  const contested = list.filter(a => a.rank <= 3 && a.of >= 8);
  if (contested.length) return contested.sort((a, b) => (b.of - a.of) || (a.rank - b.rank))[0];
  const some = list.filter(a => a.of >= 5);
  return some.length ? some[0] : list[0];
}

function summarise(store, metrics, ranks, nameByIndex, iconOf, previous = null) {
  const sum = (arr) => { let t = 0; for (let i = 0; i < arr.length; i++) t += arr[i]; return t; };
  const PREFIXES = [
    ['mined/', 'mined', null],
    ['killed/', 'killed', null],
    ['crafted/', 'crafted', null],
    ['used/', 'used', null],
    ['killed_by/', 'killed_by', 'killed'],
  ];
  const totals = PREFIXES.map(() => new Map());

  const keyBucket = new Int8Array(store.keys.length).fill(-1);
  const keyLeaf = new Array(store.keys.length);
  for (let k = 0; k < store.keys.length; k++) {
    const key = store.keys[k];
    for (let b = 0; b < PREFIXES.length; b++) {
      if (key.startsWith(PREFIXES[b][0])) {
        keyBucket[k] = b;
        keyLeaf[k] = key.slice(PREFIXES[b][0].length);
        break;
      }
    }
  }

  for (let p = 0; p < store.playerCount; p++) {
    const s0 = store.rowStart[p], e0 = store.rowStart[p + 1];
    for (let i = s0; i < e0; i++) {
      const kid = store.idx[i];
      const b = keyBucket[kid];
      if (b < 0) continue;
      const m = totals[b], leaf = keyLeaf[kid];
      m.set(leaf, (m.get(leaf) || 0) + store.val[i]);
    }
  }

  const topOf = (b) => {
    const [, cat, alt] = PREFIXES[b];
    return [...totals[b].entries()].sort((a, c) => c[1] - a[1]).slice(0, 10)
      .map(([id, count]) => ({
        id, label: pretty(id), count,
        icon: iconOf(cat, id) || (alt ? iconOf(alt, id) : null),
        sprite: safeId(id),
      }));
  };

  const prevRanks = (previous && previous.ranks) || null;
  const board = (key, t, values, fmt) => {
    if (!t) return [];
    const mi = RANK_METRIC_INDEX.get(key);
    return t.order.slice(0, 10).map((p, i) => {
      const uuid = store.uuids[p];
      const row = { rank: i + 1, uuid, name: nameByIndex[p],
                    value: fmt ? fmt(values[p]) : values[p] };
      const prev = prevRanks && mi !== undefined ? prevRanks.get(uuid) : null;
      const was = prev ? prev[mi] | 0 : 0;
      if (prev) { row.was = was || null; row.moved = was ? was - row.rank : null; }
      return row;
    });
  };

  const active = ranks.playtime ? ranks.playtime.of : store.playerCount;
  const hours = (v) => Number((v / 20 / 3600).toFixed(1));
  const km = (v) => Number((v / 100000).toFixed(1));

  return {
    players_active: store.playerCount,
    playtime_hours: Number((sum(metrics.playtime) / 20 / 3600).toFixed(1)),
    blocks_mined: sum(metrics.mined),
    mobs_killed: sum(metrics.killed),
    items_crafted: sum(metrics.crafted),
    items_used: sum(metrics.used),
    deaths: sum(metrics.deaths),
    jumps: sum(metrics.jumps),
    damage_dealt: sum(metrics.damage),
    distance_km: Number((sum(metrics.distance) / 100000).toFixed(1)),
    avg_playtime_hours: active ? Number((sum(metrics.playtime) / 20 / 3600 / active).toFixed(1)) : 0,
    top_mined: topOf(0),
    top_killed: topOf(1),
    top_crafted: topOf(2),
    top_used: topOf(3),
    top_deaths: topOf(4),
    movement_since: (previous && previous.at) || null,
    leaderboards: {
      playtime: board('playtime', ranks.playtime, metrics.playtime, hours),
      mined:    board('mined', ranks.mined, metrics.mined),
      killed:   board('killed', ranks.killed, metrics.killed),
      distance: board('distance', ranks.distance, metrics.distance, km),
      crafted:  board('crafted', ranks.crafted, metrics.crafted),
      deaths:   board('deaths', ranks.deaths, metrics.deaths),
    },
  };
}

function subtract(latest, baseline) {
  const baseIndex = new Map();
  baseline.uuids.forEach((u, i) => baseIndex.set(u, i));
  const out = new (latest.constructor)();
  for (let p = 0; p < latest.playerCount; p++) {
    const uuid = latest.uuids[p];
    const bp = baseIndex.get(uuid);
    const counters = {};
    const s = latest.rowStart[p], e = latest.rowStart[p + 1];
    for (let i = s; i < e; i++) {
      const key = latest.keys[latest.idx[i]];
      const now = latest.val[i];
      if (bp === undefined) { counters[key] = now; continue; }
      if (GAUGES.has(key)) continue;
      const was = baseline.get(bp, baseline.keyIdOf(key));
      const d = now - was;
      if (d > 0) counters[key] = d;
    }
    out.addPlayer(uuid, counters);
  }
  return out.freeze();
}
