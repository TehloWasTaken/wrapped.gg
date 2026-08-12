import {
  json, err, now, ulid, sha256, safeEqual, randomToken, isSlugBase, slugSuffix,
  slugify, escapeHtml, rateLimit, purgeServerObjects,
} from '../lib/util.js';
import { currentUser } from '../auth/discord.js';

const TOKEN_PREFIX = 'wgg_host_';
export const CLAIM_DAYS = 90;
const MAX_CREATES_PER_HOUR = 300;
const KEY_NAME = 'Panel upload';

export async function authenticatePartner(request, env) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  if (!m) return null;
  const presented = m[1].trim();
  if (!presented.startsWith(TOKEN_PREFIX) || presented.length > 128) return null;

  const hash = await sha256(presented);
  const row = await env.DB.prepare(
    `SELECT p.*, u.id AS owner_id FROM partners p JOIN users u ON u.id = p.user_id
      WHERE p.token_hash = ?`).bind(hash).first();
  if (!row || row.revoked_at) return null;
  if (!safeEqual(hash, row.token_hash)) return null;
  await env.DB.prepare('UPDATE partners SET last_used_at = ? WHERE id = ?')
    .bind(now(), row.id).run();

  if (row.suspended_at) return { suspended: true, name: row.name };

  return row;
}

const siteUrl = (env, request) => {
  try { return new URL(request.url).origin; } catch { return env.SITE_URL; }
};

async function resolveServer(env, partner, ref) {
  const q = ref.startsWith('ext:')
    ? env.DB.prepare('SELECT * FROM servers WHERE partner_id = ? AND external_ref = ?')
        .bind(partner.id, ref.slice(4))
    : env.DB.prepare('SELECT * FROM servers WHERE id = ? AND partner_id = ?')
        .bind(ref, partner.id);
  return q.first();
}

const unclaimed = (server, partner) => server.owner_id === partner.user_id;

async function mintUploadKey(env, serverId, replace = true) {
  if (replace) {
    await env.DB.prepare(
      `UPDATE api_keys SET revoked_at = ?
        WHERE server_id = ? AND name = ? AND revoked_at IS NULL`)
      .bind(now(), serverId, KEY_NAME).run();
  }
  const plain = `wgg_live_${randomToken(24)}`;
  await env.DB.prepare(
    'INSERT INTO api_keys (id, server_id, name, key_hash, prefix, created_at) VALUES (?,?,?,?,?,?)')
    .bind(ulid(), serverId, KEY_NAME, await sha256(plain), plain.slice(0, 16), now()).run();
  return plain;
}

export async function mintClaim(env, serverId) {
  const token = randomToken(24);
  const t = now();
  await env.DB.prepare(
    'INSERT INTO claim_tokens (token_hash, server_id, created_at, expires_at) VALUES (?,?,?,?)')
    .bind(await sha256(token), serverId, t, t + CLAIM_DAYS * 86400).run();
  return { token, expires_at: t + CLAIM_DAYS * 86400 };
}

const view = (env, request, s, extra = {}) => ({
  server_id: s.id,
  external_id: s.external_ref,
  name: s.name,
  slug: s.slug,
  url: `${siteUrl(env, request)}/${s.slug}`,
  published: !!s.published,
  claimed: s.owner_id !== extra._partnerUser,
  created_at: s.created_at,
  ...Object.fromEntries(Object.entries(extra).filter(([k]) => !k.startsWith('_'))),
});

export async function handlePing(request, env, partner) {
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM servers WHERE partner_id = ?').bind(partner.id).first();
  return json({
    ok: true,
    partner: { name: partner.name, slug: partner.slug },
    servers: count?.n || 0,
    max_servers: partner.max_servers,
  });
}

export async function handleCreate(request, env, partner) {
  if (!await rateLimit(env, `host:${partner.id}`, MAX_CREATES_PER_HOUR, 3600)) {
    return err('rate_limited',
      `Up to ${MAX_CREATES_PER_HOUR} create calls an hour. Get in touch if you are migrating a fleet.`,
      429);
  }

  const body = await request.json().catch(() => ({}));
  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 48) {
    return err('bad_name', 'name must be 2 - 48 characters', 400);
  }
  const external = String(body.external_id || '').trim();
  if (external.length < 1 || external.length > 64) {
    return err('bad_external_id',
      'external_id is required: your own id for this server, 1 - 64 characters. ' +
      'It is what makes this call safe to retry.', 400);
  }

  const existing = await env.DB.prepare(
    'SELECT * FROM servers WHERE partner_id = ? AND external_ref = ?')
    .bind(partner.id, external).first();
  if (existing) {
    const rotate = body.rotate_key === true;
    return json(view(env, request, existing, {
      _partnerUser: partner.user_id,
      created: false,
      upload_key: rotate ? await mintUploadKey(env, existing.id) : null,
      note: rotate ? 'A new key was issued; the previous panel key is revoked.'
                   : 'This external_id already has a Wrapped. Pass "rotate_key": true for a new upload key.',
    }));
  }

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM servers WHERE partner_id = ?').bind(partner.id).first();
  if ((count?.n || 0) >= partner.max_servers) {
    return err('too_many', 'You have reached your server limit. Get in touch and we will raise it.', 409);
  }

  const base = slugify(body.slug || name) || 'server';
  if (!isSlugBase(base)) {
    return err('bad_slug', 'slug must be 2 - 24 characters: lowercase letters, numbers and dashes', 400);
  }

  let slug = null;
  for (let i = 0; i < 6 && !slug; i++) {
    const candidate = `${base}-${slugSuffix()}`;
    const taken = await env.DB.prepare('SELECT 1 FROM servers WHERE slug = ?').bind(candidate).first();
    if (!taken) slug = candidate;
  }
  if (!slug) return err('slug_taken', 'Could not allocate a URL. Try a different name.', 409);

  const id = ulid(), t = now();
  await env.DB.prepare(
    `INSERT INTO servers (id, slug, name, description, owner_id, partner_id, external_ref,
                          published, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(id, slug, name, String(body.description || '').slice(0, 280),
          partner.user_id, partner.id, external,
          body.published === false ? 0 : 1, t, t).run();

  const upload_key = await mintUploadKey(env, id, false);
  const claim = await mintClaim(env, id);

  return json({
    server_id: id,
    external_id: external,
    name,
    slug,
    url: `${siteUrl(env, request)}/${slug}`,
    published: body.published !== false,
    claimed: false,
    created: true,
    created_at: t,
    upload_key,
    claim_url: `${siteUrl(env, request)}/claim/${claim.token}`,
    claim_expires_at: claim.expires_at,
    upload: {
      endpoint: `${siteUrl(env, request)}/v1/snapshots`,
      shell: `curl -sL ${siteUrl(env, request)}/u | sh -s -- --key ${upload_key}`,
    },
  }, 201);
}

export async function handleList(request, env, partner) {
  const url = new URL(request.url);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const before = url.searchParams.get('before');
  const rows = await env.DB.prepare(
    `SELECT s.*, (SELECT players FROM builds b WHERE b.server_id = s.id AND b.is_live = 1) AS players
       FROM servers s
      WHERE s.partner_id = ? AND (? IS NULL OR s.created_at < ?)
      ORDER BY s.created_at DESC LIMIT ?`)
    .bind(partner.id, before || null, Number(before) || 0, limit).all();

  const list = (rows.results || []).map(s =>
    view(env, request, s, { _partnerUser: partner.user_id, players: s.players || 0 }));
  return json({
    servers: list,
    next_before: list.length === limit ? list[list.length - 1].created_at : null,
  });
}

export async function handleGet(request, env, partner, ref) {
  const s = await resolveServer(env, partner, ref);
  if (!s) return err('not_found', 'No such server for this partner', 404);

  const snap = await env.DB.prepare(
    `SELECT id, state, error, players, received_at, built_at, bytes, source
       FROM snapshots WHERE server_id = ? ORDER BY received_at DESC LIMIT 1`)
    .bind(s.id).first();
  const build = await env.DB.prepare(
    'SELECT players, created_at FROM builds WHERE server_id = ? AND is_live = 1').bind(s.id).first();

  return json(view(env, request, s, {
    _partnerUser: partner.user_id,
    players: build?.players || 0,
    built_at: build?.created_at || null,
    last_snapshot: snap || null,
  }));
}

export async function handleUpdate(request, env, partner, ref) {
  const s = await resolveServer(env, partner, ref);
  if (!s) return err('not_found', 'No such server for this partner', 404);
  if (!unclaimed(s, partner)) {
    return err('claimed',
      'This server has been claimed by its owner. You can still send snapshots, ' +
      'but only they can rename, unpublish or delete it.', 409);
  }

  const body = await request.json().catch(() => ({}));
  const fields = [], args = [];
  const set = (col, val) => { fields.push(`${col} = ?`); args.push(val); };
  if (typeof body.name === 'string' && body.name.trim().length >= 2) set('name', body.name.trim().slice(0, 48));
  if (typeof body.description === 'string') set('description', body.description.slice(0, 280));
  if (typeof body.published === 'boolean') set('published', body.published ? 1 : 0);
  if (!fields.length) return json(view(env, request, s, { _partnerUser: partner.user_id }));

  set('updated_at', now());
  args.push(s.id);
  await env.DB.prepare(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run();
  const fresh = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(s.id).first();
  return json(view(env, request, fresh, { _partnerUser: partner.user_id }));
}

export async function handleRotateKey(request, env, partner, ref) {
  const s = await resolveServer(env, partner, ref);
  if (!s) return err('not_found', 'No such server for this partner', 404);
  const key = await mintUploadKey(env, s.id);
  return json({ server_id: s.id, slug: s.slug, upload_key: key,
                note: 'The previous panel key is revoked.' });
}

export async function handleClaimLink(request, env, partner, ref) {
  const s = await resolveServer(env, partner, ref);
  if (!s) return err('not_found', 'No such server for this partner', 404);
  if (!unclaimed(s, partner)) {
    return err('claimed', 'Someone has already claimed this server.', 409);
  }
  const claim = await mintClaim(env, s.id);
  return json({
    server_id: s.id,
    claim_url: `${siteUrl(env, request)}/claim/${claim.token}`,
    expires_at: claim.expires_at,
  });
}

export async function handleDelete(request, env, partner, ref) {
  const s = await resolveServer(env, partner, ref);
  if (!s) return err('not_found', 'No such server for this partner', 404);
  if (!unclaimed(s, partner)) {
    return err('claimed',
      'This server belongs to its owner now. Only they can delete it.', 409);
  }

  await purgeServerObjects(env, s.id);
  await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(s.id).run();
  return json({ deleted: true });
}

export async function handleClaim(request, env, token) {
  const user = await currentUser(request, env);
  if (!user) {
    return new Response(null, {
      status: 302,
      headers: { location: `/auth/login?next=/claim/${encodeURIComponent(token)}` },
    });
  }

  const row = await env.DB.prepare(
    `SELECT c.*, s.name, s.slug FROM claim_tokens c JOIN servers s ON s.id = c.server_id
      WHERE c.token_hash = ?`).bind(await sha256(token)).first();

  if (!row) return claimPage('That link is not valid', 'Ask your host for a new one.', 404);
  if (row.used_at) {
    return claimPage('That link has been used',
      'Someone has already claimed this server. If it was you, it is in your panel.', 409);
  }
  if (row.expires_at < now()) {
    return claimPage('That link has expired', 'Ask your host for a new one.', 410);
  }

  const t = now();
  await env.DB.batch([
    env.DB.prepare('UPDATE servers SET owner_id = ?, updated_at = ? WHERE id = ?')
      .bind(user.id, t, row.server_id),
    env.DB.prepare('UPDATE claim_tokens SET used_at = ?, used_by = ? WHERE token_hash = ?')
      .bind(t, user.id, row.token_hash),
    env.DB.prepare('UPDATE claim_tokens SET used_at = ?, used_by = ? WHERE server_id = ? AND used_at IS NULL')
      .bind(t, user.id, row.server_id),
  ]);

  return new Response(null, { status: 302, headers: { location: '/panel?claimed=' + row.slug } });
}

const claimPage = (title, body, status) => new Response(
  `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} - wrapped.gg</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="stylesheet" href="/assets/app.css">
<body class="app"><main class="wrap narrow" style="text-align:center">
<h1>${escapeHtml(title)}</h1><p class="lede" style="margin-inline:auto">${escapeHtml(body)}</p>
<a class="btn lg primary" href="/panel">Open the panel</a></main>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

export async function routeHost(request, env, { seg, method }) {
  const partner = await authenticatePartner(request, env);
  if (!partner) {
    return err('unauthorized',
      'Send a partner token as `Authorization: Bearer wgg_host_…`. ' +
      'Server upload keys (wgg_live_…) do not work here. ' +
      'See https://wrapped.gg/hosts', 401);
  }
  if (partner.suspended) {
    return err('suspended',
      `The token for ${partner.name} is paused. Existing pages are unaffected and ` +
      'nothing has been deleted - get in touch and we will lift it.', 403);
  }

  const what = seg[2], ref = seg[3] && decodeURIComponent(seg[3]), action = seg[4];

  if (what === 'ping' && method === 'GET') return handlePing(request, env, partner);

  if (what === 'servers') {
    if (!ref) {
      if (method === 'GET') return handleList(request, env, partner);
      if (method === 'POST') return handleCreate(request, env, partner);
    } else if (!action) {
      if (method === 'GET') return handleGet(request, env, partner, ref);
      if (method === 'PATCH') return handleUpdate(request, env, partner, ref);
      if (method === 'DELETE') return handleDelete(request, env, partner, ref);
    } else if (method === 'POST') {
      if (action === 'key') return handleRotateKey(request, env, partner, ref);
      if (action === 'claim') return handleClaimLink(request, env, partner, ref);
    }
  }

  return err('not_found', 'No such endpoint. See https://wrapped.gg/hosts', 404);
}
