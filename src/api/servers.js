import {
  json, err, now, ulid, sha256, randomToken, isSlugBase, slugSuffix, slugify,
  purgeServerObjects, normName, fallbackName,
} from '../lib/util.js';
import { requireUser } from '../auth/discord.js';
import { authenticateKey } from './ingest.js';
import { parseWorldBorn } from '../lib/birthday.js';
import { uuidVariants } from '../lib/mojang.js';

const MAX_SERVERS_PER_USER = 10;
const MAX_BLOCKED = 200;
const UUID_RE = /^[0-9a-fA-F-]{32,36}$/;
const MAX_LOGO_BYTES = 512 * 1024;
const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const SESSION_KEY_NAME = 'Website upload';

async function ownedServer(env, user, id) {
  const row = await env.DB.prepare('SELECT * FROM servers WHERE id = ? AND owner_id = ?')
    .bind(id, user.id).first();
  if (!row) throw err('not_found', 'No such server', 404);
  return row;
}

export async function handleMe(request, env) {
  const user = await requireUser(request, env);
  const servers = await env.DB.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM snapshots sn WHERE sn.server_id = s.id) AS snapshots,
            (SELECT players FROM builds b WHERE b.server_id = s.id AND b.is_live = 1) AS live_players
       FROM servers s WHERE s.owner_id = ? ORDER BY s.created_at DESC`)
    .bind(user.id).all();
  return json({ user, servers: servers.results || [] });
}

async function allocateSlug(env, base) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const candidate = `${base}-${slugSuffix()}`;
    const taken = await env.DB.prepare('SELECT 1 FROM servers WHERE slug = ?').bind(candidate).first();
    if (!taken) return candidate;
  }
  return null;
}

export async function handleCreateServer(request, env) {
  const user = await requireUser(request, env);
  const body = await request.json().catch(() => ({}));

  const name = String(body.name || '').trim();
  if (name.length < 2 || name.length > 48) return err('bad_name', 'Name must be 2 - 48 characters', 400);

  const base = slugify(body.slug || name);
  if (!isSlugBase(base)) {
    return err('bad_slug',
      'Use 2 - 24 characters: lowercase letters, numbers and dashes, not starting or ending with a dash', 400);
  }

  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM servers WHERE owner_id = ?')
    .bind(user.id).first();
  if ((count?.n || 0) >= MAX_SERVERS_PER_USER) {
    return err('too_many', `You can create up to ${MAX_SERVERS_PER_USER} servers`, 409);
  }

  const slug = await allocateSlug(env, base);
  if (!slug) return err('slug_taken', 'Could not allocate a URL. Try a different name.', 409);

  const id = ulid(), t = now();
  await env.DB.prepare(
    `INSERT INTO servers (id, slug, name, description, owner_id,
                          published, created_at, updated_at)
     VALUES (?,?,?,?,?,0,?,?)`)
    .bind(id, slug, name, String(body.description || '').slice(0, 280), user.id, t, t).run();

  const key = await mintKey(env, id, 'Default');
  return json({ id, slug, name, key }, 201);
}

async function storeLogo(request, env, server) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const ext = LOGO_TYPES[type];
  if (!ext) return err('bad_type', 'Logo must be a PNG, JPEG or WebP image', 415);

  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.length) return err('empty_body', 'No image in the request body', 400);
  if (bytes.length > MAX_LOGO_BYTES) {
    return err('too_large', 'Logo must be under 512 KB', 413, { limit_kb: MAX_LOGO_BYTES / 1024 });
  }

  const key = `logo/${server.id}/${randomToken(8)}.${ext}`;
  await env.R2.put(key, bytes, { httpMetadata: { contentType: type } });

  const previous = server.icon_key;
  await env.DB.prepare('UPDATE servers SET icon_key = ?, updated_at = ? WHERE id = ?')
    .bind(key, now(), server.id).run();
  if (previous && previous !== key) await env.R2.delete(previous).catch(() => {});

  return json({ icon_key: key, url: `/logo/${server.slug}.png` });
}

export async function handleUploadLogo(request, env, id) {
  const user = await requireUser(request, env);
  const server = await ownedServer(env, user, id);
  return storeLogo(request, env, server);
}

export async function handleKeyLogo(request, env) {
  const auth = await authenticateKey(request, env);
  if (!auth) return err('unauthorized', 'Bad or revoked API key', 401);

  const server = await env.DB.prepare(
    'SELECT id, slug, icon_key FROM servers WHERE id = ?').bind(auth.server_id).first();
  if (!server) return err('not_found', 'No such server', 404);

  const ifAbsent = new URL(request.url).searchParams.get('if_absent') !== '0';
  if (ifAbsent && server.icon_key) {
    return json({ skipped: true, reason: 'a logo is already set' });
  }
  return storeLogo(request, env, server);
}

export async function handleDeleteLogo(request, env, id) {
  const user = await requireUser(request, env);
  const server = await ownedServer(env, user, id);
  if (server.icon_key) await env.R2.delete(server.icon_key).catch(() => {});
  await env.DB.prepare('UPDATE servers SET icon_key = NULL, updated_at = ? WHERE id = ?')
    .bind(now(), id).run();
  return json({ removed: true });
}

export async function handleServeLogo(env, slug) {
  const row = await env.DB.prepare('SELECT icon_key FROM servers WHERE slug = ?')
    .bind(slug).first();
  if (!row || !row.icon_key) return new Response('Not found', { status: 404 });

  const obj = await env.R2.get(row.icon_key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'content-type': obj.httpMetadata?.contentType || 'image/png',
      'cache-control': 'public, max-age=300, s-maxage=3600',
    },
  });
}

export async function handleUpdateServer(request, env, id) {
  const user = await requireUser(request, env);
  const server = await ownedServer(env, user, id);
  const body = await request.json().catch(() => ({}));

  const fields = [], args = [];
  const set = (col, val) => { fields.push(`${col} = ?`); args.push(val); };

  if ('name' in body) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 2 || name.length > 48) {
      return err('bad_name', 'Name must be 2 - 48 characters', 400);
    }
    set('name', name);
  }
  if (typeof body.description === 'string') set('description', body.description.slice(0, 280));
  if (typeof body.palette === 'number') set('palette', Math.max(0, Math.min(5, body.palette | 0)));
  if (typeof body.published === 'boolean') set('published', body.published ? 1 : 0);
  if ('world_born_at' in body) {
    const born = parseWorldBorn(body.world_born_at);
    if (born === undefined) {
      return err('bad_birthday',
        'World birthday must be a date like 2019-06-14, no earlier than 2009 and not in the future', 400);
    }
    set('world_born_at', born);
  }
  if (typeof body.baseline_snapshot_id === 'string' || body.baseline_snapshot_id === null) {
    if (body.baseline_snapshot_id) {
      const ok = await env.DB.prepare('SELECT 1 FROM snapshots WHERE id = ? AND server_id = ?')
        .bind(body.baseline_snapshot_id, id).first();
      if (!ok) return err('bad_baseline', 'That snapshot does not belong to this server', 400);
    }
    set('baseline_snapshot_id', body.baseline_snapshot_id || null);
  }
  if (!fields.length) return json(server);

  set('updated_at', now());
  args.push(id);
  await env.DB.prepare(`UPDATE servers SET ${fields.join(', ')} WHERE id = ?`).bind(...args).run();
  return json(await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first());
}

export async function handleDeleteServer(request, env, id) {
  const user = await requireUser(request, env);
  await ownedServer(env, user, id);

  await purgeServerObjects(env, id);
  await env.DB.prepare('DELETE FROM servers WHERE id = ?').bind(id).run();
  return json({ deleted: true });
}

export async function mintKey(env, serverId, name) {
  const plain = `wgg_live_${randomToken(24)}`;
  await env.DB.prepare(
    'INSERT INTO api_keys (id, server_id, name, key_hash, prefix, created_at) VALUES (?,?,?,?,?,?)')
    .bind(ulid(), serverId, name.slice(0, 32), await sha256(plain), plain.slice(0, 16), now()).run();
  return plain;
}

export async function handleSessionKey(request, env, id) {
  const user = await requireUser(request, env);
  await ownedServer(env, user, id);

  await env.DB.prepare(
    `UPDATE api_keys SET revoked_at = ?
      WHERE server_id = ? AND name = ? AND revoked_at IS NULL`)
    .bind(now(), id, SESSION_KEY_NAME).run();

  const key = await mintKey(env, id, SESSION_KEY_NAME);
  return json({ key });
}

export async function handleCreateKey(request, env, id) {
  const user = await requireUser(request, env);
  await ownedServer(env, user, id);
  const body = await request.json().catch(() => ({}));
  const key = await mintKey(env, id, String(body.name || 'Key'));
  return json({ key, note: 'Copy this now - it cannot be shown again.' }, 201);
}

export async function handleRevokeKey(request, env, id, keyId) {
  const user = await requireUser(request, env);
  await ownedServer(env, user, id);
  await env.DB.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND server_id = ?')
    .bind(now(), keyId, id).run();
  return json({ revoked: true });
}

export async function queueRebuild(env, serverId) {
  const live = await env.DB.prepare(
    'SELECT latest_id FROM builds WHERE server_id = ? AND is_live = 1').bind(serverId).first();
  if (!live || !live.latest_id) return false;
  await env.DB.prepare("UPDATE snapshots SET state = 'queued', error = NULL WHERE id = ?")
    .bind(live.latest_id).run();
  await env.BUILD_QUEUE.send({ snapshot_id: live.latest_id, server_id: serverId });
  return true;
}

export async function handleSearchPlayers(request, env, id) {
  const user = await requireUser(request, env);
  await ownedServer(env, user, id);

  const q = normName(new URL(request.url).searchParams.get('q') || '');
  if (!q || q.length > 32) return json({ players: [] });

  const rows = await env.DB.prepare(
    `SELECT p.uuid, p.name, p.platform, p.playtime_h,
            EXISTS (SELECT 1 FROM blocked_players b
                     WHERE b.server_id = p.server_id AND b.uuid = p.uuid) AS blocked
       FROM players p
      WHERE p.server_id = ? AND p.name_lower LIKE ?
      ORDER BY p.playtime_h DESC LIMIT 12`).bind(id, q + '%').all();

  return json({
    players: (rows.results || []).map(r => ({ ...r, blocked: !!r.blocked })),
  });
}

export async function handleListBlocked(request, env, id) {
  const user = await requireUser(request, env);
  await ownedServer(env, user, id);
  const rows = await env.DB.prepare(
    `SELECT uuid, name, created_at FROM blocked_players
      WHERE server_id = ? ORDER BY created_at DESC`).bind(id).all();
  return json({ blocked: rows.results || [], limit: MAX_BLOCKED });
}

export async function handleBlockPlayer(request, env, id) {
  const user = await requireUser(request, env);
  await ownedServer(env, user, id);
  const body = await request.json().catch(() => ({}));

  const asked = String(body.uuid || '').trim();
  if (!UUID_RE.test(asked)) {
    return err('bad_uuid', 'Pick a player from the search results', 400);
  }
  const variants = uuidVariants(asked.toLowerCase());

  const already = await env.DB.prepare(
    `SELECT uuid FROM blocked_players
      WHERE server_id = ? AND uuid IN (${variants.map(() => '?').join(',')})`)
    .bind(id, ...variants).first();
  if (already) return err('already_blocked', 'That player is already blocked', 409);

  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM blocked_players WHERE server_id = ?').bind(id).first();
  if ((count?.n || 0) >= MAX_BLOCKED) {
    return err('too_many', `You can block up to ${MAX_BLOCKED} players`, 409);
  }

  const known = await env.DB.prepare(
    `SELECT uuid, name FROM players
      WHERE server_id = ? AND uuid IN (${variants.map(() => '?').join(',')})`)
    .bind(id, ...variants).first();

  const uuid = known ? known.uuid : variants[0];
  const name = (known && known.name)
    || String(body.name || '').trim().slice(0, 32)
    || fallbackName(uuid);

  const t = now();
  await env.DB.prepare(
    'INSERT INTO blocked_players (server_id, uuid, name, created_at) VALUES (?,?,?,?)')
    .bind(id, uuid, name, t).run();

  return json({ blocked: { uuid, name, created_at: t }, rebuilding: await queueRebuild(env, id) }, 201);
}

export async function handleUnblockPlayer(request, env, id, rawUuid) {
  const user = await requireUser(request, env);
  await ownedServer(env, user, id);

  const asked = decodeURIComponent(rawUuid || '').trim();
  if (!UUID_RE.test(asked)) return err('bad_uuid', 'No player with that id is blocked', 400);
  const variants = uuidVariants(asked.toLowerCase());

  const res = await env.DB.prepare(
    `DELETE FROM blocked_players
      WHERE server_id = ? AND uuid IN (${variants.map(() => '?').join(',')})`)
    .bind(id, ...variants).run();
  if (res?.meta?.changes === 0) return err('not_blocked', 'That player is not blocked', 404);

  return json({ removed: true, rebuilding: await queueRebuild(env, id) });
}

export async function handleListSnapshots(request, env, id) {
  const user = await requireUser(request, env);
  await ownedServer(env, user, id);
  const rows = await env.DB.prepare(
    `SELECT id, taken_at, received_at, source, players, bytes, state, error, built_at
       FROM snapshots WHERE server_id = ? ORDER BY received_at DESC LIMIT 50`).bind(id).all();
  const keys = await env.DB.prepare(
    `SELECT id, name, prefix, created_at, last_used_at, revoked_at
       FROM api_keys WHERE server_id = ? ORDER BY created_at DESC`).bind(id).all();
  return json({ snapshots: rows.results || [], keys: keys.results || [] });
}
