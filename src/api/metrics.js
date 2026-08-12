import { safeEqual } from '../lib/util.js';

const RATES = {
  request:        0.30 / 1_000_000,
  cpu_ms:         0.02 / 1_000_000,
  r2_storage_gb:  0.015,
  r2_class_a:     4.50 / 1_000_000,
  r2_class_b:     0.36 / 1_000_000,
  d1_rows_written: 1.00 / 1_000_000,
  included_requests: 10_000_000,
  included_cpu_ms:   30_000_000,
  included_r2_gb:    10,
  base_monthly:      5.00,
};

const OG_RENDER_MS = 250;
const BUILD_MS_EST = 2400;
const STUCK_AFTER_S = 3600;

const SNAPSHOT_STATES = ['queued', 'building', 'ready', 'failed'];
const PARTNER_STATES = ['active', 'paused', 'revoked'];
const WINDOWS = ['24h', '30d'];

const EVENTS = {
  page_view:       { help: 'Player and server page views', label: 'kind',   known: ['player', 'server'] },
  player_read:     { help: 'Player document reads',        label: 'result', known: ['hit', 'miss'] },
  og_image:        { help: 'OG preview images served',     label: 'result', known: ['cached', 'rendered'] },
  head_image:      { help: 'Player head images served',    label: 'result', known: ['cached', 'fetched'] },
  snapshot_upload: { help: 'Snapshot uploads accepted',    label: 'source', known: ['browser', 'shell', 'pterodactyl', 'unknown'] },
  build:           { help: 'Builds run',                   label: 'result', known: ['ok', 'failed'] },
  name_lookup:     { help: 'UUID to name lookups',         label: 'tier',   known: ['kv', 'usercache', 'geyser', 'mojang'] },
};

const SPLIT_IN_BLOB2 = new Set(['head_image', 'name_lookup']);

export async function handleMetrics(request, env) {
  const auth = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  const token = env.METRICS_TOKEN;
  if (!token || !m || !safeEqual(m[1].trim(), token)) {
    return new Response('Not found', { status: 404 });
  }

  const out = [];
  const seen = new Set();
  const g = (name, help, value, labels) => {
    if (!seen.has(name)) {
      out.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
      seen.add(name);
    }
    out.push(labels ? `${name}{${labels}} ${value}` : `${name} ${value}`);
  };

  const q = async (sql, ...args) => {
    try { return await env.DB.prepare(sql).bind(...args).first(); }
    catch { return null; }
  };
  const rows = async (sql, ...args) => {
    try { return (await env.DB.prepare(sql).bind(...args).all()).results || []; }
    catch { return []; }
  };

  const t = Math.floor(Date.now() / 1000);
  const day = t - 86400;
  const month = t - 30 * 86400;

  const users     = await q('SELECT COUNT(*) AS n FROM users WHERE discord_id NOT LIKE ?', 'partner:%');
  const newUsers  = await q('SELECT COUNT(*) AS n FROM users WHERE created_at > ? AND discord_id NOT LIKE ?',
                            month, 'partner:%');
  const servers   = await q('SELECT COUNT(*) AS n, SUM(published) AS pub FROM servers');
  const partnerSrv = await q('SELECT COUNT(*) AS n FROM servers WHERE partner_id IS NOT NULL');
  const players   = await q('SELECT COUNT(*) AS n, SUM(playtime_h) AS hours FROM players');
  const livePlayers = await q('SELECT COALESCE(SUM(players), 0) AS n FROM builds WHERE is_live = 1');
  const snaps     = await q('SELECT COUNT(*) AS n, SUM(bytes) AS bytes FROM snapshots');
  const snapsDay  = await q('SELECT COUNT(*) AS n FROM snapshots WHERE received_at > ?', day);
  const stuck     = await q('SELECT COUNT(*) AS n FROM snapshots WHERE state = ? AND received_at < ?',
                            'building', t - STUCK_AFTER_S);
  const builds    = await q('SELECT COUNT(*) AS n FROM builds');
  const activeSrv = await q(
    'SELECT COUNT(DISTINCT server_id) AS n FROM snapshots WHERE received_at > ?', month);
  const byState   = await rows('SELECT state, COUNT(*) AS n FROM snapshots GROUP BY state');
  const bedrock   = await q("SELECT COUNT(*) AS n FROM players WHERE platform = 'bedrock'");
  const partners  = await q(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN revoked_at IS NOT NULL THEN 1 ELSE 0 END) AS revoked,
            SUM(CASE WHEN revoked_at IS NULL AND suspended_at IS NOT NULL THEN 1 ELSE 0 END) AS paused
       FROM partners`);
  const claims    = await q(
    'SELECT COUNT(*) AS n FROM claim_tokens WHERE used_at IS NULL AND expires_at > ?', t);
  const usercache = await q('SELECT COUNT(*) AS n FROM usercache');

  g('wrapped_users_total', 'Discord accounts that have signed in, partner logins excluded', users?.n || 0);
  g('wrapped_users_new_30d', 'Accounts created in the last 30 days', newUsers?.n || 0);
  g('wrapped_servers_total', 'Servers created', servers?.n || 0);
  g('wrapped_servers_published', 'Servers with a public Wrapped', servers?.pub || 0);
  g('wrapped_servers_active_30d', 'Servers that uploaded in the last 30 days', activeSrv?.n || 0);
  g('wrapped_servers_partner_owned', 'Servers created through a hosting partner', partnerSrv?.n || 0);
  g('wrapped_players_indexed', 'Players across all live builds', players?.n || 0);
  g('wrapped_players_bedrock', 'Of those, Bedrock/Geyser players', bedrock?.n || 0);
  g('wrapped_players_live', 'Players counted by the live build of each server', livePlayers?.n || 0);
  g('wrapped_player_hours_total', 'Sum of playtime across all indexed players', Math.round(players?.hours || 0));
  g('wrapped_builds_total', 'Builds ever produced', builds?.n || 0);
  g('wrapped_snapshots_total', 'Snapshots ever accepted', snaps?.n || 0);
  g('wrapped_snapshots_24h', 'Snapshots accepted in the last 24 hours', snapsDay?.n || 0);
  g('wrapped_snapshots_stuck', `Snapshots still building after ${STUCK_AFTER_S / 60} minutes`, stuck?.n || 0);

  const stateCounts = Object.fromEntries(SNAPSHOT_STATES.map(s => [s, 0]));
  for (const row of byState) stateCounts[row.state] = row.n;
  for (const [state, n] of Object.entries(stateCounts)) {
    g('wrapped_snapshots_by_state', 'Snapshots by build state', n, `state="${state}"`);
  }

  const partnerCounts = {
    revoked: partners?.revoked || 0,
    paused: partners?.paused || 0,
    active: (partners?.n || 0) - (partners?.revoked || 0) - (partners?.paused || 0),
  };
  g('wrapped_partners_total', 'Hosting partners registered', partners?.n || 0);
  for (const state of PARTNER_STATES) {
    g('wrapped_partners_by_state', 'Hosting partners by state', partnerCounts[state], `state="${state}"`);
  }
  g('wrapped_claims_open', 'Claim links issued and not yet used', claims?.n || 0);
  g('wrapped_usercache_entries', 'UUID to name pairs held in D1', usercache?.n || 0);

  const snapBytes = Number(snaps?.bytes || 0);
  g('wrapped_r2_snapshot_bytes', 'Bytes of raw snapshots held in R2', snapBytes);

  const ev = await queryEvents(env);
  g('wrapped_analytics_available', 'Whether the Analytics Engine query succeeded', ev ? 1 : 0);

  for (const [name, spec] of Object.entries(EVENTS)) {
    for (const win of WINDOWS) {
      const bucket = ev?.[win]?.[name] || {};
      const total = Object.values(bucket).reduce((a, b) => a + b, 0);
      g(`wrapped_${name}_${win}`, `${spec.help} (last ${win})`, total);

      const values = { ...Object.fromEntries(spec.known.map(k => [k, 0])), ...bucket };
      for (const [label, n] of Object.entries(values)) {
        if (!label) continue;
        g(`wrapped_${name}_${win}_by_${spec.label}`,
          `${spec.help}, split by ${spec.label} (last ${win})`, n, `${spec.label}="${label}"`);
      }
    }
  }

  const total = (win, name) =>
    Object.values(ev?.[win]?.[name] || {}).reduce((a, b) => a + b, 0);
  const reqs30    = total('30d', 'page_view') * 3;
  const ogRend30  = ev?.['30d']?.og_image?.rendered || 0;
  const builds30  = total('30d', 'build');
  const cpu30     = ogRend30 * OG_RENDER_MS + builds30 * BUILD_MS_EST;
  const storageGb = (snapBytes + (players?.n || 0) * 4200) / 1e9;

  const over = (v, inc) => Math.max(0, v - inc);
  const est = RATES.base_monthly
    + over(reqs30, RATES.included_requests) * RATES.request
    + over(cpu30, RATES.included_cpu_ms) * RATES.cpu_ms
    + over(storageGb, RATES.included_r2_gb) * RATES.r2_storage_gb;

  g('wrapped_est_requests_30d', 'Estimated billable requests (30d)', Math.round(reqs30));
  g('wrapped_est_cpu_ms_30d', 'Estimated CPU-milliseconds consumed (30d)', Math.round(cpu30));
  g('wrapped_est_storage_gb', 'Estimated R2 storage in use', storageGb.toFixed(3));
  g('wrapped_est_cost_usd_month', 'Estimated monthly spend, base plan included', est.toFixed(4));
  g('wrapped_est_cost_usd_og_30d', 'Estimated spend on OG rendering (30d)',
    (ogRend30 * (OG_RENDER_MS * RATES.cpu_ms + RATES.r2_class_a)).toFixed(6));

  out.push('');
  return new Response(out.join('\n'), {
    headers: {
      'content-type': 'text/plain; version=0.0.4; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function queryEvents(env) {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return null;

  const sql = (days) => `
    SELECT blob1 AS name, blob2 AS b2, blob3 AS b3, SUM(_sample_interval) AS n
      FROM wrapped_events
     WHERE timestamp > NOW() - INTERVAL '${days}' DAY
     GROUP BY name, b2, b3`;

  const run = async (days) => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      { method: 'POST',
        headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` },
        body: sql(days) });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    if (!body?.data) return null;
    const out = {};
    for (const row of body.data) {
      const name = row.name;
      if (!name) continue;
      const split = SPLIT_IN_BLOB2.has(name) ? row.b2 : row.b3;
      const bucket = out[name] || (out[name] = {});
      const key = String(split || '');
      bucket[key] = (bucket[key] || 0) + (Number(row.n) || 0);
    }
    return out;
  };

  try {
    const [d1, d30] = await Promise.all([run(1), run(30)]);
    if (!d1 && !d30) return null;
    return { '24h': d1 || {}, '30d': d30 || {} };
  } catch { return null; }
}
