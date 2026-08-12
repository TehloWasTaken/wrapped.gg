import { buildFromStream } from './build.js';
import { now, ulid, fallbackName } from '../lib/util.js';
import { trackBuild } from '../lib/metrics.js';
import { readRanks, ranksHeader, ranksLine, ranksKey, MAX_TRACKED_PLAYERS } from './ranks.js';

// D1 caps bound params at 100 per statement: 10 rows x 9 columns = 90.
const ROWS_PER_STMT = 10;
const STMTS_PER_BATCH = 100;

export async function handleBuild(message, env) {
  const { snapshot_id, server_id } = message.body || {};
  if (!snapshot_id || !server_id) return;

  const mark = (state, extra = {}) => env.DB.prepare(
    `UPDATE snapshots SET state = ?, error = ?, players = ?, built_at = ? WHERE id = ?`)
    .bind(state, extra.error || null, extra.players || 0,
          extra.built ? now() : null, snapshot_id).run();

  // Progress goes in the error column because that's the field the panel
  // already polls. While state is 'building' it reads as "last thing that
  // happened", which is what you want if the build dies without saying why.
  const stage = (name) => env.DB.prepare(
    'UPDATE snapshots SET error = ? WHERE id = ?')
    .bind(`in progress: ${name}`, snapshot_id).run().catch(() => {});

  const startedAt = Date.now();
  try {
    await mark('building');
    await stage('reading the snapshot');

    const snap = await env.DB.prepare(
      'SELECT r2_key FROM snapshots WHERE id = ? AND server_id = ?')
      .bind(snapshot_id, server_id).first();
    if (!snap) throw new Error('snapshot row vanished');

    const obj = await env.R2.get(snap.r2_key);
    if (!obj) throw new Error('snapshot body missing from storage');

    const server = await env.DB.prepare(
      'SELECT baseline_snapshot_id FROM servers WHERE id = ?')
      .bind(server_id).first();

    let baseline = null;
    if (server?.baseline_snapshot_id && server.baseline_snapshot_id !== snapshot_id) {
      const b = await env.DB.prepare(
        'SELECT r2_key FROM snapshots WHERE id = ? AND server_id = ?')
        .bind(server.baseline_snapshot_id, server_id).first();
      if (b) {
        const bo = await env.R2.get(b.r2_key);
        if (bo) baseline = await collectStore(bo.body);
      }
    }

    const previous = await loadPreviousRanks(
      env, server_id, server?.baseline_snapshot_id || null, snapshot_id);

    const blocked = await loadBlocked(env, server_id);

    const chunks = [];
    const index = [];
    let offset = 0;
    const enc = new TextEncoder();

    const rankLines = [''];

    const result = await buildFromStream(obj.body, {
      baseline,
      previous,
      blocked,
      onStage: (name, info) => stage(
        `${name} ${info.players} players, ${info.entries} counters, ${info.keys} keys`),
      onRanks: (uuid, vec) => { rankLines.push(ranksLine(uuid, vec)); },
      onPlayer: (doc) => {
        const line = enc.encode(JSON.stringify(doc) + '\n');
        chunks.push(line);
        index.push([doc.uuid, doc.name, doc.platform, doc.playtime_hours, offset, line.length]);
        offset += line.length;
      },
    });

    if (!index.length) {
      throw new Error(result.skipped
        ? 'every player in this snapshot is blocked'
        : 'no players in snapshot');
    }
    await stage(`packing ${index.length} players`);

    const buildId = ulid();
    const packedKey = `build/${buildId}/players.ndjson`;
    const summaryKey = `build/${buildId}/server.json`;

    await env.R2.put(packedKey, new Blob(chunks), {
      httpMetadata: { contentType: 'application/x-ndjson' },
    });
    chunks.length = 0;
    await env.R2.put(summaryKey, JSON.stringify(result.server), {
      httpMetadata: { contentType: 'application/json' },
    });

    const t = now();

    rankLines[0] = ranksHeader(t) + '\n';
    await env.R2.put(ranksKey(buildId), new Blob(rankLines), {
      httpMetadata: { contentType: 'text/plain' },
    });
    rankLines.length = 0;

    await stage('writing the player index');

    await env.DB.prepare(
      `INSERT INTO builds (id, server_id, baseline_id, latest_id, window_from, window_to,
                           players, created_at, is_live)
       VALUES (?,?,?,?,?,?,?,?,0)`)
      .bind(buildId, server_id, server?.baseline_snapshot_id || null, snapshot_id,
            null, t, index.length, t).run();

    await env.DB.prepare('DELETE FROM players WHERE server_id = ?').bind(server_id).run();

    const stmts = [];
    for (let i = 0; i < index.length; i += ROWS_PER_STMT) {
      const slice = index.slice(i, i + ROWS_PER_STMT);
      const holders = slice.map(() => '(?,?,?,?,?,?,?,?,?)').join(',');
      const args = [];
      for (const [uuid, name, platform, hrs, off, len] of slice) {
        const display = name || fallbackName(uuid);
        args.push(server_id, uuid, display, display.toLowerCase(),
                  platform, hrs, off, len, t);
      }
      stmts.push(env.DB.prepare(
        `INSERT OR REPLACE INTO players
           (server_id, uuid, name, name_lower, platform, playtime_h, pack_off, pack_len, updated_at)
         VALUES ${holders}`).bind(...args));
    }
    for (let i = 0; i < stmts.length; i += STMTS_PER_BATCH) {
      await env.DB.batch(stmts.slice(i, i + STMTS_PER_BATCH));
    }

    await stage('publishing');
    await env.DB.batch([
      env.DB.prepare('UPDATE builds SET is_live = 0 WHERE server_id = ?').bind(server_id),
      env.DB.prepare('UPDATE builds SET is_live = 1 WHERE id = ?').bind(buildId),
      env.DB.prepare('UPDATE servers SET updated_at = ? WHERE id = ?').bind(t, server_id),
    ]);

    await mark('ready', { players: index.length, built: true });
    trackBuild(env, server_id, index.length, Date.now() - startedAt, true);

    await pruneOldBuilds(env, server_id, buildId);
  } catch (e) {
    await mark('failed', { error: String(e && e.message || e).slice(0, 300) });
    trackBuild(env, server_id, 0, Date.now() - startedAt, false);
    throw e;
  }
}

async function loadBlocked(env, serverId) {
  const rows = await env.DB.prepare(
    'SELECT uuid FROM blocked_players WHERE server_id = ?').bind(serverId).all();
  return new Set((rows.results || []).map(row => row.uuid));
}

async function loadPreviousRanks(env, serverId, baselineId, snapshotId) {
  try {
    const prev = await env.DB.prepare(
      `SELECT id, baseline_id, players, created_at FROM builds
        WHERE server_id = ? AND latest_id != ?
        ORDER BY created_at DESC LIMIT 1`).bind(serverId, snapshotId).first();
    if (!prev) return null;
    // different baseline, different window - movement would be meaningless
    if ((prev.baseline_id || null) !== (baselineId || null)) return null;
    if ((prev.players || 0) > MAX_TRACKED_PLAYERS) return null;

    const obj = await env.R2.get(ranksKey(prev.id));
    if (!obj) return null;

    const read = await readRanks(obj.body);
    if (!read) return null;
    return { at: read.at || prev.created_at, ranks: read.ranks };
  } catch (e) {
    console.log('previous ranks unavailable', serverId, e && e.message);
    return null;
  }
}

async function collectStore(stream) {
  const { CounterStore } = await import('./columnar.js');
  const { readNdjson, maybeGunzipStream } = await import('./ndjson.js');
  const store = new CounterStore();
  await readNdjson(await maybeGunzipStream(stream), {
    onPlayer: (row) => { if (row?.u) store.addPlayer(row.u, row.c || {}); },
  });
  return store.freeze();
}

async function pruneOldBuilds(env, serverId, keepId) {
  const old = await env.DB.prepare(
    `SELECT id FROM builds WHERE server_id = ? AND id != ?
      ORDER BY created_at DESC LIMIT 20 OFFSET 1`).bind(serverId, keepId).all();
  for (const row of old.results || []) {
    await env.R2.delete(`build/${row.id}/players.ndjson`);
    await env.R2.delete(`build/${row.id}/server.json`);
    await env.R2.delete(ranksKey(row.id));
    await env.DB.prepare('DELETE FROM builds WHERE id = ?').bind(row.id).run();
  }
}
