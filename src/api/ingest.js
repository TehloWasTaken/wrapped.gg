import { json, err, now, ulid, sha256, safeEqual, rateLimit } from '../lib/util.js';
import { trackUpload } from '../lib/metrics.js';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_PER_DAY = 6;

export async function authenticateKey(request, env) {
  const auth = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (!m) return null;
  const presented = m[1].trim();
  if (presented.length < 20 || presented.length > 128) return null;

  const hash = await sha256(presented);
  const row = await env.DB.prepare(
    `SELECT k.id AS key_id, k.key_hash, k.revoked_at,
            s.id AS server_id, s.slug
       FROM api_keys k JOIN servers s ON s.id = k.server_id
      WHERE k.key_hash = ?`).bind(hash).first();
  if (!row || row.revoked_at) return null;
  // redundant while the lookup is by hash - keeps it constant-time if that
  // ever becomes a prefix lookup plus a compare
  if (!safeEqual(hash, row.key_hash)) return null;

  await env.DB.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?')
    .bind(now(), row.key_id).run();
  return row;
}

export async function handleIngest(request, env, ctx) {
  const server = await authenticateKey(request, env);
  if (!server) return err('unauthorized', 'Bad or revoked API key', 401);

  if (!await rateLimit(env, `ingest:${server.server_id}`, MAX_PER_DAY, 86400)) {
    return err('rate_limited',
      `This is an annual product - ${MAX_PER_DAY} uploads a day is plenty.`, 429);
  }

  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) {
    return err('payload_too_large', 'Snapshot exceeds 64 MB gzipped', 413,
               { limit_mb: MAX_BYTES / 1048576 });
  }
  if (!request.body) return err('empty_body', 'No snapshot in the request body', 400);

  const idem = request.headers.get('idempotency-key');
  if (idem) {
    const dupe = await env.DB.prepare(
      'SELECT id, state FROM snapshots WHERE server_id = ? AND idem_key = ?')
      .bind(server.server_id, idem).first();
    if (dupe) {
      if (dupe.state !== 'ready') {
        await env.DB.prepare(
          "UPDATE snapshots SET state = 'queued', error = NULL WHERE id = ?").bind(dupe.id).run();
        await env.BUILD_QUEUE.send({ snapshot_id: dupe.id, server_id: server.server_id });
        return json({ snapshot_id: dupe.id, state: 'queued', duplicate: true,
                      requeued: true, slug: server.slug });
      }
      return json({ snapshot_id: dupe.id, state: dupe.state, duplicate: true, slug: server.slug });
    }
  }

  const id = ulid();
  const key = `snapshots/${server.server_id}/${id}.ndjson.gz`;

  // Straight into R2 without reading it: 60 MB costs the same memory as empty,
  // and a broken file then fails on the queue, where there's a row to write the
  // reason into. Parsing here would just be a 500 with nowhere to put it.
  let stored;
  try {
    stored = await env.R2.put(key, request.body, {
      httpMetadata: { contentType: 'application/x-ndjson', contentEncoding: 'gzip' },
      customMetadata: { server_id: server.server_id, snapshot_id: id },
    });
  } catch (e) {
    return err('storage_failed', 'Could not store the snapshot', 502);
  }

  // content-length is a claim, and chunked uploads don't send one at all
  const size = stored?.size ?? declared;
  if (size > MAX_BYTES) {
    await env.R2.delete(key);
    return err('payload_too_large', 'Snapshot exceeds 64 MB gzipped', 413);
  }

  const t = now();
  const source = (request.headers.get('x-wrapped-source') || 'unknown').slice(0, 24);
  await env.DB.prepare(
    `INSERT INTO snapshots
       (id, server_id, r2_key, idem_key, taken_at, received_at, source, players, bytes, state)
     VALUES (?,?,?,?,?,?,?,0,?, 'queued')`)
    .bind(id, server.server_id, key, idem || id, t, t, source, size).run();

  trackUpload(env, server.slug, size, source);
  await env.BUILD_QUEUE.send({ snapshot_id: id, server_id: server.server_id });

  return json({
    snapshot_id: id,
    state: 'queued',
    bytes: size,
    poll: `/v1/snapshots/${id}`,
    slug: server.slug,
  }, 201);
}

export async function handleSnapshotStatus(request, env, id) {
  const server = await authenticateKey(request, env);
  if (!server) return err('unauthorized', 'Bad or revoked API key', 401);
  const row = await env.DB.prepare(
    `SELECT id, state, players, taken_at, built_at, error
       FROM snapshots WHERE id = ? AND server_id = ?`)
    .bind(id, server.server_id).first();
  if (!row) return err('not_found', 'No such snapshot', 404);
  return json({ ...row, slug: server.slug });
}
