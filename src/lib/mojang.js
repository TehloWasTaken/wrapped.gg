import { trackNameLookup } from './metrics.js';
import { isFloodgateUuid, xuidOf, floodgateUuid, isGamertag } from './util.js';

const PROVIDERS = [
  {
    id: 'playerdb',
    url: (q) => `https://playerdb.co/api/player/minecraft/${encodeURIComponent(q)}`,
    parse: (b) => {
      const p = b && b.data && b.data.player;
      if (!p || !p.username) return null;
      return { name: p.username, uuid: dashless(p.raw_id || p.id || '') };
    },
  },
  {
    id: 'ashcon',
    url: (q) => `https://api.ashcon.app/mojang/v2/user/${encodeURIComponent(q)}`,
    parse: (b) => (b && b.username
      ? { name: b.username, uuid: dashless(b.uuid || '') } : null),
  },
];

// Bedrock names come from Geyser. false = miss, null = ask again later.
// 503 is a miss: it's what they answer when the gamertag isn't in their cache.
const GEYSER = 'https://api.geysermc.org/v2/xbox';

async function geyserGamertag(uuid) {
  const xuid = xuidOf(uuid);
  if (!xuid) return false;
  try {
    const res = await fetch(`${GEYSER}/gamertag/${xuid}`, {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404 || res.status === 503) return false;
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const tag = body && body.gamertag;
    return isGamertag(tag) ? { name: tag, uuid: dashless(uuid) } : false;
  } catch { return null; }
}

async function geyserXuid(gamertag) {
  try {
    const res = await fetch(`${GEYSER}/xuid/${encodeURIComponent(gamertag)}`, {
      headers: { accept: 'application/json' },
    });
    if (res.status === 404 || res.status === 503) return false;
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    const uuid = body && body.xuid != null ? floodgateUuid(body.xuid) : null;
    return uuid ? { uuid: dashless(uuid), name: gamertag } : false;
  } catch { return null; }
}

const NAME_TTL = 60 * 60 * 24 * 30;
const MISS_TTL = 60 * 15;
// ceiling on outbound lookups per request; the rest resolve next page view
const MAX_LIVE_LOOKUPS = 24;
// bump to orphan every cached name at once
const NS = 'v4';

const dashless = (u) => String(u || '').replace(/-/g, '').toLowerCase();

const kvRemember = (env, uuid, name) => Promise.all([
  env.KV.put(`mcname:${NS}:${uuid}`, name, { expirationTtl: NAME_TTL }),
  env.KV.put(`mcuuid:${NS}:${name.toLowerCase()}`, uuid, { expirationTtl: NAME_TTL }),
]).catch(() => {});

const CACHE_READ_CHUNK = 90;

async function cacheGetNames(env, uuids) {
  const out = new Map();
  for (let i = 0; i < uuids.length; i += CACHE_READ_CHUNK) {
    const slice = uuids.slice(i, i + CACHE_READ_CHUNK);
    try {
      const rows = await env.DB.prepare(
        `SELECT uuid, name FROM usercache WHERE uuid IN (${slice.map(() => '?').join(',')})`)
        .bind(...slice).all();
      for (const r of rows.results || []) out.set(r.uuid, r.name);
    } catch {}
  }
  return out;
}

async function cacheGetUuid(env, nameLower) {
  try {
    const row = await env.DB.prepare(
      'SELECT uuid, name FROM usercache WHERE name_lower = ? ORDER BY updated_at DESC LIMIT 1')
      .bind(nameLower).first();
    return row?.uuid ? { uuid: row.uuid, name: row.name } : null;
  } catch { return null; }
}

const UPSERT = (rows) =>
  `INSERT INTO usercache (uuid, name, name_lower, source, first_seen, updated_at)
   VALUES ${Array.from({ length: rows }, () => '(?,?,?,?,?,?)').join(',')}
   ON CONFLICT(uuid) DO UPDATE SET
     name = excluded.name, name_lower = excluded.name_lower,
     source = excluded.source, updated_at = excluded.updated_at`;

async function cachePut(env, uuid, name) {
  const t = Date.now() / 1000 | 0;
  try {
    await env.DB.prepare(UPSERT(1))
      .bind(uuid, name, name.toLowerCase(), isFloodgateUuid(uuid) ? 'geyser' : 'mojang', t, t).run();
  } catch {}
}

const FILE_ROWS_PER_STMT = 16;
const MAX_REMEMBER = 200;
const PLAYER_NAME = /^[a-zA-Z0-9_]{3,16}$/;

async function fileNames(env, entries) {
  const t = Date.now() / 1000 | 0;
  try {
    const stmts = [];
    for (let i = 0; i < entries.length; i += FILE_ROWS_PER_STMT) {
      const slice = entries.slice(i, i + FILE_ROWS_PER_STMT);
      const args = [];
      for (const [u, n] of slice) args.push(u, n, n.toLowerCase(), 'upload', t, t);
      stmts.push(env.DB.prepare(UPSERT(slice.length)).bind(...args));
    }
    await env.DB.batch(stmts);
  } catch (e) {
    console.warn('usercache file', String(e && e.message || e));
    return 0;
  }
  return entries.length;
}

async function fileUnknown(env, want) {
  if (!want.size) return 0;
  const fresh = [];
  await Promise.all([...want].map(async ([u, n]) => {
    // an entry here means we already know this uuid. only empties get filed:
    // a different name is a rename, and the upload isn't the authority on that
    const hit = await env.KV.get(`mcname:${NS}:${u}`).catch(() => null);
    if (!hit || hit === '!') fresh.push([u, n]);
  }));
  if (!fresh.length) return 0;

  const filed = await fileNames(env, fresh);
  if (!filed) return 0;
  await Promise.all(fresh.map(([u, n]) => kvRemember(env, u, n)));
  return filed;
}

export function rememberNames(env, pairs, ctx) {
  const want = new Map();
  for (const [uuid, name] of pairs || []) {
    const u = dashless(uuid);
    const n = String(name || '').trim();
    if (!isJavaUuid(u) || !PLAYER_NAME.test(n)) continue;
    want.set(u, n);
    if (want.size >= MAX_REMEMBER) break;
  }
  const work = fileUnknown(env, want);
  if (ctx) ctx.waitUntil(work);
  return work;
}

const isJavaUuid = (u) => {
  const d = dashless(u);
  return d.length === 32 && !isFloodgateUuid(d);
};

const isResolvable = (u) => isJavaUuid(u) || isFloodgateUuid(u);

async function lookup(query) {
  let definiteMiss = false;

  for (const provider of PROVIDERS) {
    try {
      const res = await fetch(provider.url(query), {
        headers: { 'user-agent': 'wrapped.gg (+https://wrapped.gg)' },
        cf: { cacheTtl: NAME_TTL, cacheEverything: true },
      });

      if (res.status === 200) {
        const parsed = provider.parse(await res.json().catch(() => null));
        if (parsed && parsed.name) return parsed;
        continue;
      }

      res.body?.cancel();

      if (res.status === 400 || res.status === 404 || res.status === 204) {
        definiteMiss = true;
        continue;
      }
      console.warn('name provider', provider.id, res.status, query);
    } catch (e) {
      console.warn('name provider', provider.id, 'threw', String(e && e.message || e));
    }
  }

  // false = they all said no such player, worth caching. null = nobody gave a
  // straight answer; caching that would turn a provider wobble into 15 minutes
  // of bogus misses.
  return definiteMiss ? false : null;
}

export async function namesForUuids(env, uuids, ctx) {
  const want = [...new Set((uuids || []).filter(isResolvable))];
  const out = new Map();
  if (!want.length) return out;

  const misses = [];
  await Promise.all(want.map(async (u) => {
    const hit = await env.KV.get(`mcname:${NS}:${dashless(u)}`);
    if (hit === '!') return;
    if (hit) out.set(u, hit);
    else misses.push(u);
  }));

  const unknown = [];
  if (misses.length) {
    const known = await cacheGetNames(env, misses.map(dashless));
    const warm = [];
    for (const u of misses) {
      const name = known.get(dashless(u));
      if (name) {
        out.set(u, name);
        warm.push(kvRemember(env, dashless(u), name));
      } else {
        unknown.push(u);
      }
    }
    if (warm.length) {
      const all = Promise.all(warm);
      ctx ? ctx.waitUntil(all) : await all;
    }
  }

  const live = unknown.slice(0, MAX_LIVE_LOOKUPS);
  trackNameLookup(env, 'kv', want.length - misses.length);
  trackNameLookup(env, 'usercache', misses.length - unknown.length);
  trackNameLookup(env, 'geyser', live.filter(isFloodgateUuid).length);
  trackNameLookup(env, 'mojang', live.filter(u => !isFloodgateUuid(u)).length);

  await Promise.all(live.map(async (u) => {
    const found = isFloodgateUuid(u) ? await geyserGamertag(u) : await lookup(dashless(u));
    if (found) {
      out.set(u, found.name);
      const puts = Promise.all([
        kvRemember(env, dashless(u), found.name),
        cachePut(env, dashless(u), found.name),
      ]);
      ctx ? ctx.waitUntil(puts) : await puts;
    } else if (found === false) {
      const put = env.KV.put(`mcname:${NS}:${dashless(u)}`, '!', { expirationTtl: MISS_TTL });
      ctx ? ctx.waitUntil(put) : await put;
    }
  }));

  return out;
}

export async function uuidForName(env, name, ctx) {
  const raw = String(name || '').trim();
  const key = raw.toLowerCase();
  const java = /^[a-z0-9_]{3,16}$/.test(key);
  if (!java && !isGamertag(raw)) return null;

  const hit = await env.KV.get(`mcuuid:${NS}:${key}`);
  if (hit === '!') return null;
  if (hit) return hit;

  const cached = await cacheGetUuid(env, key);
  if (cached) {
    const put = kvRemember(env, cached.uuid, cached.name);
    ctx ? ctx.waitUntil(put) : await put;
    return cached.uuid;
  }

  // a gamertag with no space looks exactly like a Java name, so Java first
  const found = java ? (await lookup(key)) || (await geyserXuid(raw))
                     : await geyserXuid(raw);
  if (found && found.uuid) {
    const puts = Promise.all([
      kvRemember(env, found.uuid, found.name),
      cachePut(env, found.uuid, found.name),
    ]);
    ctx ? ctx.waitUntil(puts) : await puts;
    return found.uuid;
  }
  if (found === false) {
    const put = env.KV.put(`mcuuid:${NS}:${key}`, '!', { expirationTtl: MISS_TTL });
    ctx ? ctx.waitUntil(put) : await put;
  }
  return null;
}

export const uuidVariants = (u) => {
  const d = dashless(u);
  if (d.length !== 32) return [u];
  const dashed = `${d.slice(0, 8)}-${d.slice(8, 12)}-${d.slice(12, 16)}-${d.slice(16, 20)}-${d.slice(20)}`;
  return [dashed, d];
};
