import { json, err, normName, escapeHtml, fallbackName, isFallbackName } from '../lib/util.js';
import { trackPlayerRead } from '../lib/metrics.js';
import { namesForUuids, uuidForName, uuidVariants, rememberNames } from '../lib/mojang.js';
import { PALETTES } from '../og/template.js';
import { worldAge } from '../lib/birthday.js';

export async function liveServer(env, slug) {
  return env.DB.prepare(
    `SELECT s.id, s.slug, s.name, s.description, s.palette, s.published, s.icon_key,
            s.world_born_at,
            b.id AS build_id, b.players, b.created_at AS built_at
       FROM servers s
       LEFT JOIN builds b ON b.server_id = s.id AND b.is_live = 1
      WHERE s.slug = ?`).bind(slug).first();
}

const SERVED_KEY = 'served:players';
const SERVED_TTL = 3600;

export async function playersServed(env) {
  try {
    const cached = await env.KV.get(SERVED_KEY);
    if (cached != null) return Number(cached) || 0;
    const row = await env.DB.prepare(
      'SELECT COALESCE(SUM(players), 0) AS n FROM builds WHERE is_live = 1').first();
    const n = Number(row?.n) || 0;
    await env.KV.put(SERVED_KEY, String(n), { expirationTtl: SERVED_TTL });
    return n;
  } catch { return 0; }
}

export const SERVED_FLOOR = 500;

export function servedLine(n) {
  if (!(n >= SERVED_FLOOR)) return '';
  return `<div class="served enter e4">
          <p class="served-n"><b>${n.toLocaleString('en-US')}</b>` +
         `<span>players already have their Wrapped</span></p>
          <p class="served-cta">Yours are one upload away</p>
        </div>`;
}

const nameOrLabel = (name, uuid) =>
  (name && !isFallbackName(name, uuid) ? name : fallbackName(uuid));

export function publicServer(server) {
  return {
    slug: server.slug,
    name: server.name,
    description: server.description,
    palette: server.palette,
    players: server.players,
    built_at: server.built_at,
    logo: server.icon_key ? `/logo/${server.slug}.png` : null,
    birthday: worldAge(server.world_born_at),
  };
}

export const NOT_BLOCKED =
  `NOT EXISTS (SELECT 1 FROM blocked_players b
                WHERE b.server_id = p.server_id AND b.uuid = p.uuid)`;

export async function findPlayer(env, serverId, rawName, ctx) {
  const name = normName(rawName);
  if (!name || name.length > 32) return null;

  const direct = await env.DB.prepare(
    `SELECT p.uuid, p.name, p.platform, p.pack_off, p.pack_len
       FROM players p
      WHERE p.server_id = ? AND p.name_lower = ? AND ${NOT_BLOCKED}`)
    .bind(serverId, name).first();
  if (direct) return direct;

  const prefixed = await env.DB.prepare(
    `SELECT p.uuid, p.name, p.platform, p.pack_off, p.pack_len
       FROM players p
      WHERE p.server_id = ? AND p.platform = 'bedrock'
        AND (p.name_lower = ? OR substr(p.name_lower, 2) = ?)
        AND ${NOT_BLOCKED}
      LIMIT 1`).bind(serverId, '.' + name, name).first();
  if (prefixed) return prefixed;

  if (/^[0-9a-fA-F-]{32,36}$/.test(rawName)) {
    const row = await byUuid(env, serverId, rawName);
    if (row) return row;
  }

  const uuid = await uuidForName(env, name, ctx);
  if (uuid) {
    const row = await byUuid(env, serverId, uuid);
    if (row) return { ...row, name: row.name && row.name !== row.uuid ? row.name : rawName };
  }
  return null;
}

async function byUuid(env, serverId, uuid) {
  const variants = uuidVariants(uuid);
  const holders = variants.map(() => '?').join(',');
  return env.DB.prepare(
    `SELECT p.uuid, p.name, p.platform, p.pack_off, p.pack_len
       FROM players p
      WHERE p.server_id = ? AND p.uuid IN (${holders}) AND ${NOT_BLOCKED}`)
    .bind(serverId, ...variants).first();
}

export async function readPlayerDoc(env, buildId, row) {
  if (!row || !row.pack_len) return null;
  const obj = await env.R2.get(`build/${buildId}/players.ndjson`, {
    range: { offset: row.pack_off, length: row.pack_len },
  });
  if (!obj) return null;
  const text = await obj.text();
  try { return JSON.parse(text); } catch { return null; }
}

export async function handlePlayerData(request, env, slug, name, ctx) {
  const server = await liveServer(env, slug);
  if (!server || !server.build_id) return err('not_found', 'No Wrapped published yet', 404);
  if (!server.published) return err('not_published', 'This Wrapped is not public yet', 404);

  const row = await findPlayer(env, server.id, name, ctx);
  trackPlayerRead(env, slug, !!row);
  if (!row) return err('no_player', `No player called "${name}" on this server`, 404);

  const doc = await readPlayerDoc(env, server.build_id, row);
  if (!doc) return err('no_data', 'That player has no data in the current build', 404);

  if (!doc.name || doc.name === doc.uuid || isFallbackName(doc.name, doc.uuid)) {
    const resolved = await namesForUuids(env, [doc.uuid], ctx);
    doc.name = resolved.get(doc.uuid) || nameOrLabel(row.name, doc.uuid);
  } else {
    rememberNames(env, [[doc.uuid, doc.name]], ctx);
  }

  return json({
    server: publicServer(server),
    player: doc,
  }, 200, {
    'cache-control': 'public, max-age=300, s-maxage=3600',
  });
}

export async function handleServerData(request, env, slug, ctx) {
  const server = await liveServer(env, slug);
  if (!server || !server.build_id) return err('not_found', 'No Wrapped published yet', 404);
  if (!server.published) return err('not_published', 'This Wrapped is not public yet', 404);

  const url = new URL(request.url);
  const q = normName(url.searchParams.get('q') || '');

  let matches = [];
  if (q.length >= 1) {
    const rows = await env.DB.prepare(
      `SELECT p.name, p.platform, p.playtime_h FROM players p
        WHERE p.server_id = ? AND p.name_lower LIKE ? AND ${NOT_BLOCKED}
        ORDER BY p.playtime_h DESC LIMIT 10`).bind(server.id, q + '%').all();
    matches = rows.results || [];
  }

  const summaryObj = await env.R2.get(`build/${server.build_id}/server.json`);
  const summary = summaryObj ? await summaryObj.json() : null;

  if (summary) await fillLeaderboardNames(env, summary, ctx);

  return json({ server: publicServer(server), summary, matches },
              200, { 'cache-control': 'public, max-age=60' });
}

async function fillLeaderboardNames(env, summary, ctx) {
  const boards = Object.values(summary.leaderboards || {});
  const missing = [];
  const known = [];
  for (const rows of boards) {
    for (const r of rows || []) {
      if (!r || !r.uuid) continue;
      if (!r.name || isFallbackName(r.name, r.uuid)) missing.push(r.uuid);
      else known.push([r.uuid, r.name]);
    }
  }
  if (known.length) rememberNames(env, known, ctx);
  if (!missing.length) return;

  const names = await namesForUuids(env, missing, ctx);
  for (const rows of boards) {
    for (const r of rows || []) {
      if (r && (!r.name || isFallbackName(r.name, r.uuid))) {
        r.name = names.get(r.uuid) || nameOrLabel(r.name, r.uuid);
      }
    }
  }
}

export function metaTags({ siteUrl, slug, playerName, serverName, summaryLine, palette, birthday }) {
  const url = playerName ? `${siteUrl}/${slug}/${encodeURIComponent(playerName)}`
                         : `${siteUrl}/${slug}`;
  const party = !playerName && birthday && birthday.is_birthday;
  const img = playerName ? `${siteUrl}/og/${slug}/${encodeURIComponent(playerName)}.png`
            : party ? `${siteUrl}/og/${slug}.png?b=${birthday.turning}`
                    : `${siteUrl}/og/${slug}.png`;
  const title = playerName ? `${playerName} - ${serverName} Wrapped`
              : party ? `${serverName} turns ${birthday.turning} - Wrapped`
                      : `${serverName} - Wrapped`;
  const desc = party
    ? `${serverName} is ${birthday.turning} years old today. ` +
      (summaryLine || `${birthday.day_number.toLocaleString('en-US')} days of it, wrapped.`)
    : (summaryLine || `A year on ${serverName}, wrapped.`);
  const alt = playerName ? `${playerName}'s Minecraft year on ${serverName}`
                         : `${serverName} - a Minecraft year in review`;
  const robots = playerName ? 'noindex, follow, max-image-preview:large'
                            : 'index, follow, max-image-preview:large';
  const accent = PALETTES[((palette | 0) % PALETTES.length + PALETTES.length) % PALETTES.length][3];
  return `
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(desc)}" />
<link rel="canonical" href="${escapeHtml(url)}" />
<meta name="robots" content="${robots}" />
<meta name="theme-color" content="${accent}" />
<meta name="color-scheme" content="dark" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="wrapped.gg" />
<meta property="og:title" content="${escapeHtml(title)}" />
<meta property="og:description" content="${escapeHtml(desc)}" />
<meta property="og:url" content="${escapeHtml(url)}" />
<meta property="og:locale" content="en_GB" />
<meta property="og:image" content="${escapeHtml(img)}" />
<meta property="og:image:type" content="image/png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="${escapeHtml(alt)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(title)}" />
<meta name="twitter:description" content="${escapeHtml(desc)}" />
<meta name="twitter:image" content="${escapeHtml(img)}" />
<meta name="twitter:image:alt" content="${escapeHtml(alt)}" />`;
}

export function embedTags({ serverName, palette }) {
  const accent = PALETTES[((palette | 0) % PALETTES.length + PALETTES.length) % PALETTES.length][3];
  return `
<title>${escapeHtml(serverName)} - Wrapped</title>
<meta name="robots" content="noindex, nofollow" />
<meta name="theme-color" content="${accent}" />
<meta name="color-scheme" content="dark" />`;
}

const SITEMAP_KEY = 'sitemap:xml';
const SITEMAP_TTL = 3600;
const SITEMAP_MAX = 40000;

const STATIC_URLS = [
  { path: '/', priority: '1.0', changefreq: 'weekly' },
  { path: '/docs', priority: '0.8', changefreq: 'monthly' },
  { path: '/hosts', priority: '0.7', changefreq: 'monthly' },
];

export async function handleSitemap(request, env) {
  const site = env.SITE_URL || 'https://wrapped.gg';
  const cached = await env.KV.get(SITEMAP_KEY).catch(() => null);
  if (cached) return sitemapResponse(cached);

  let rows = [];
  try {
    rows = (await env.DB.prepare(
      `SELECT s.slug, b.created_at AS built_at
         FROM servers s
         JOIN builds b ON b.server_id = s.id AND b.is_live = 1
        WHERE s.published = 1
        ORDER BY b.created_at DESC
        LIMIT ?`).bind(SITEMAP_MAX).all()).results || [];
  } catch { rows = []; }

  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const newest = rows.length ? day(rows[0].built_at) : day(Math.floor(Date.now() / 1000));

  const urls = STATIC_URLS.map(u => entry(
    site + u.path, u.path === '/' ? newest : null, u.changefreq, u.priority));
  for (const r of rows) {
    urls.push(entry(`${site}/${encodeURIComponent(r.slug)}`, day(r.built_at), 'weekly', '0.6'));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
  await env.KV.put(SITEMAP_KEY, xml, { expirationTtl: SITEMAP_TTL }).catch(() => {});
  return sitemapResponse(xml);
}

function entry(loc, lastmod, changefreq, priority) {
  return '  <url>\n' +
    `    <loc>${escapeHtml(loc)}</loc>\n` +
    (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : '') +
    `    <changefreq>${changefreq}</changefreq>\n` +
    `    <priority>${priority}</priority>\n` +
    '  </url>';
}

function sitemapResponse(xml) {
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=600, s-maxage=3600',
    },
  });
}
