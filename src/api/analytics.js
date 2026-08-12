import { json, err } from '../lib/util.js';
import { requireUser } from '../auth/discord.js';

const DAYS = 30;

export async function serverTraffic(env, slug) {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) {
    return {
      available: false,
      reason: 'Analytics is not configured on this deployment yet.',
    };
  }

  const daily = await runQuery(env, `
    SELECT
      toStartOfInterval(timestamp, INTERVAL '1' DAY) AS day,
      blob1 AS name,
      blob3 AS kind,
      blob4 AS surface,
      SUM(_sample_interval) AS n
    FROM wrapped_events
    WHERE blob2 = '${esc(slug)}'
      AND timestamp > NOW() - INTERVAL '${DAYS}' DAY
    GROUP BY day, name, kind, surface
    ORDER BY day`);

  if (!daily) {
    return { available: false, reason: 'Could not reach the analytics API.' };
  }

  const series = {};
  const dayKeys = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = DAYS - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * 86400000).toISOString().slice(0, 10);
    dayKeys.push(d);
  }
  const blank = () => Object.fromEntries(dayKeys.map(d => [d, 0]));
  for (const k of ['views', 'player_views', 'embed_views', 'cards', 'lookups']) series[k] = blank();

  let totals = { views: 0, player_views: 0, embed_views: 0, cards: 0, lookups: 0, misses: 0 };

  for (const row of daily) {
    const day = String(row.day || '').slice(0, 10);
    const n = Number(row.n) || 0;
    if (!(day in series.views)) continue;
    switch (row.name) {
      case 'page_view':
        series.views[day] += n;
        totals.views += n;
        if (row.kind === 'player') { series.player_views[day] += n; totals.player_views += n; }
        if (row.surface === 'embed') { series.embed_views[day] += n; totals.embed_views += n; }
        break;
      case 'og_image':
        series.cards[day] += n;
        totals.cards += n;
        break;
      case 'player_read':
        series.lookups[day] += n;
        totals.lookups += n;
        if (row.kind === 'miss') totals.misses += n;
        break;
    }
  }

  return {
    available: true,
    slug,
    days: dayKeys,
    series: {
      views: dayKeys.map(d => series.views[d]),
      player_views: dayKeys.map(d => series.player_views[d]),
      embed_views: dayKeys.map(d => series.embed_views[d]),
      cards: dayKeys.map(d => series.cards[d]),
    },
    totals,
    miss_rate: totals.lookups ? Number((totals.misses / totals.lookups * 100).toFixed(1)) : 0,
  };
}

export async function handleAnalytics(request, env, id) {
  const user = await requireUser(request, env);
  const server = await env.DB.prepare(
    'SELECT id, slug, name FROM servers WHERE id = ? AND owner_id = ?')
    .bind(id, user.id).first();
  if (!server) return err('not_found', 'No such server', 404);

  return json(await serverTraffic(env, server.slug), 200,
              { 'cache-control': 'private, max-age=120' });
}

const esc = (s) => String(s).replace(/'/g, "''").replace(/[^a-z0-9_-]/g, '');

async function runQuery(env, sql) {
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      { method: 'POST', headers: { authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}` }, body: sql });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    return body?.data || null;
  } catch { return null; }
}
