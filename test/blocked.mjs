import assert from 'node:assert';
import { buildFromStream } from '../src/build/build.js';
import { toNdjson } from '../src/build/ndjson.js';
import {
  handleListBlocked, handleBlockPlayer, handleUnblockPlayer, handleSearchPlayers,
} from '../src/api/servers.js';

const t = Math.floor(Date.now() / 1000);
const USER = { id: 'u1', discord_id: '100000000000000001', username: 'Ari', avatar: null };

const uuid = (n) => `0000000${n}-1111-2222-3333-44444444444${n}`;

const PLAYERS = {
  [uuid(1)]: { 'custom/play_time': 20 * 3600 * 100, 'mined/stone': 5000, 'custom/deaths': 3 },
  [uuid(2)]: { 'custom/play_time': 20 * 3600 * 80, 'mined/stone': 4000, 'custom/deaths': 9 },
  [uuid(3)]: { 'custom/play_time': 20 * 3600 * 60, 'mined/stone': 3000, 'custom/deaths': 1 },
  [uuid(4)]: { 'custom/play_time': 20 * 3600 * 40, 'mined/stone': 2000, 'custom/deaths': 2 },
};
const NAMES = { [uuid(1)]: 'Alpha', [uuid(2)]: 'Griefer', [uuid(3)]: 'Cara', [uuid(4)]: 'Dee' };

const snapshot = () => new Blob([toNdjson({
  snapshot_at: t, source: 'test', players: PLAYERS, names: NAMES,
})]).stream();

const build = (blocked) => buildFromStream(snapshot(), { collect: true, blocked });

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label); };

console.log('the build:');

const whole = await build(null);
const without = await build(new Set([uuid(2)]));

await check('every player is in the build when nobody is blocked', () => {
  assert.equal(whole.players.length, 4);
  assert.equal(whole.skipped, 0);
});

await check('a blocked player is dropped as the snapshot is read', () => {
  assert.equal(without.players.length, 3);
  assert.equal(without.skipped, 1);
  assert.ok(!without.players.some(p => p.uuid === uuid(2)));
});

await check('and leaves every leaderboard', () => {
  for (const [key, rows] of Object.entries(without.server.leaderboards)) {
    assert.ok(!rows.some(r => r.uuid === uuid(2)), `${key} still lists them`);
  }
  assert.ok(whole.server.leaderboards.deaths.some(r => r.uuid === uuid(2)));
});

await check('the players below them move up a place', () => {
  const before = whole.server.leaderboards.playtime.map(r => r.name);
  const after = without.server.leaderboards.playtime.map(r => r.name);
  assert.deepEqual(before, ['Alpha', 'Griefer', 'Cara', 'Dee']);
  assert.deepEqual(after, ['Alpha', 'Cara', 'Dee']);
  assert.equal(without.players.find(p => p.name === 'Cara').rank.playtime.rank, 2);
  assert.equal(without.players.find(p => p.name === 'Cara').rank.playtime.of, 3);
});

await check('their hours stop counting towards the server totals', () => {
  assert.equal(whole.server.playtime_hours, 280);
  assert.equal(without.server.playtime_hours, 200);
  assert.equal(whole.server.blocks_mined, 14000);
  assert.equal(without.server.blocks_mined, 10000);
  assert.equal(without.server.players_active, 3);
});

await check('blocking is by uuid, in either spelling and either case', async () => {
  for (const spelling of [uuid(2).replace(/-/g, ''), uuid(2).toUpperCase(),
                          uuid(2).replace(/-/g, '').toUpperCase()]) {
    const out = await build(new Set([spelling]));
    assert.equal(out.players.length, 3, spelling);
  }
});

await check('an empty blocklist costs the build nothing', async () => {
  const empty = await build(new Set());
  assert.equal(empty.players.length, 4);
  assert.equal(empty.skipped, 0);
});

console.log('\nthe panel API:');

function fakeEnv(state) {
  const rows = (sql, args) => {
    if (sql.includes('FROM sessions s JOIN users u')) return [{ ...USER, expires_at: t + 3600 }];
    if (sql.includes('FROM servers WHERE id = ? AND owner_id = ?')) {
      return args[0] === state.server.id && args[1] === state.server.owner_id
        ? [{ ...state.server }] : [];
    }
    if (sql.includes('FROM players')) {
      const found = state.players.filter(p => p.server_id === args[0]);
      const blocked = new Set(state.blocked.map(b => b.uuid));
      if (sql.includes('uuid IN')) {
        return found.filter(p => args.slice(1).includes(p.uuid));
      }
      const q = String(args[1] || '').replace(/%$/, '');
      return found.filter(p => p.name.toLowerCase().startsWith(q))
        .map(p => ({ ...p, blocked: blocked.has(p.uuid) ? 1 : 0 }));
    }
    if (sql.includes('FROM blocked_players')) {
      let list = state.blocked.filter(b => b.server_id === args[0]);
      if (sql.includes('uuid IN')) list = list.filter(b => args.slice(1).includes(b.uuid));
      if (sql.includes('COUNT(*)')) return [{ n: list.length }];
      return list.map(b => ({ uuid: b.uuid, name: b.name, created_at: b.created_at }));
    }
    if (sql.includes('FROM builds')) return state.live ? [{ latest_id: state.live }] : [];
    return [];
  };

  const run = (sql, args) => {
    if (sql.startsWith('INSERT INTO blocked_players')) {
      state.blocked.push({ server_id: args[0], uuid: args[1], name: args[2], created_at: args[3] });
      return { meta: { changes: 1 } };
    }
    if (sql.startsWith('DELETE FROM blocked_players')) {
      const before = state.blocked.length;
      state.blocked = state.blocked.filter(
        b => !(b.server_id === args[0] && args.slice(1).includes(b.uuid)));
      return { meta: { changes: before - state.blocked.length } };
    }
    if (sql.includes('UPDATE snapshots SET')) { state.requeued.push(args[0]); return { meta: {} }; }
    return { meta: { changes: 0 } };
  };

  return {
    DB: {
      prepare(sql) {
        let args = [];
        const stmt = {
          bind: (...a) => { args = a; return stmt; },
          first: async () => rows(sql, args)[0] || null,
          all: async () => ({ results: rows(sql, args) }),
          run: async () => run(sql, args),
        };
        return stmt;
      },
    },
    BUILD_QUEUE: { send: async (m) => { state.queued.push(m); } },
  };
}

const newState = () => ({
  server: { id: 's1', slug: 'example-k7m2p', name: 'Example SMP', owner_id: USER.id },
  players: [
    { server_id: 's1', uuid: uuid(1), name: 'Alpha', platform: 'java', playtime_h: 100 },
    { server_id: 's1', uuid: uuid(2), name: 'Griefer', platform: 'java', playtime_h: 80 },
  ],
  blocked: [],
  live: 'snap1',
  queued: [],
  requeued: [],
});

const call = (fn, state, path, opts = {}, ...rest) =>
  fn(new Request(`https://wrapped.gg${path}`, {
    headers: { cookie: 'wgg_session=sid', 'content-type': 'application/json' },
    ...opts,
  }), fakeEnv(state), state.server.id, ...rest)
    .catch((e) => { if (e instanceof Response) return e; throw e; });

const post = (state, body) =>
  call(handleBlockPlayer, state, '/v1/servers/s1/blocked',
       { method: 'POST', body: JSON.stringify(body) });

await check('the list starts empty', async () => {
  const state = newState();
  const res = await call(handleListBlocked, state, '/v1/servers/s1/blocked');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.blocked, []);
  assert.equal(body.limit, 200);
});

await check('blocking stores the name it had, so the row still reads after a rebuild', async () => {
  const state = newState();
  const res = await post(state, { uuid: uuid(2) });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.blocked.name, 'Griefer');
  assert.equal(body.blocked.uuid, uuid(2));
  assert.equal(state.blocked.length, 1);
});

await check('blocking rebuilds the live snapshot instead of waiting for an upload', async () => {
  const state = newState();
  const body = await (await post(state, { uuid: uuid(2) })).json();
  assert.equal(body.rebuilding, true);
  assert.deepEqual(state.queued, [{ snapshot_id: 'snap1', server_id: 's1' }]);
  assert.deepEqual(state.requeued, ['snap1']);
});

await check('with no build yet there is nothing to rebuild, and it says so', async () => {
  const state = { ...newState(), live: null };
  const body = await (await post(state, { uuid: uuid(2) })).json();
  assert.equal(body.rebuilding, false);
  assert.equal(state.queued.length, 0);
  assert.equal(state.blocked.length, 1);
});

await check('blocking the same player twice is refused, not duplicated', async () => {
  const state = newState();
  await post(state, { uuid: uuid(2) });
  const res = await post(state, { uuid: uuid(2).toUpperCase() });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error, 'already_blocked');
  assert.equal(state.blocked.length, 1);
});

await check('a uuid that is not one is refused', async () => {
  const state = newState();
  for (const bad of ['', 'Griefer', 'abc', null, 42]) {
    const res = await post(state, { uuid: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal((await res.json()).error, 'bad_uuid');
  }
  assert.equal(state.blocked.length, 0);
});

await check('a player the build has never seen can still be blocked by uuid', async () => {
  const state = newState();
  const body = await (await post(state, { uuid: uuid(9), name: 'Ghost' })).json();
  assert.equal(body.blocked.name, 'Ghost');
  assert.equal(body.blocked.uuid, uuid(9));
});

await check('and without a name to go on, the id stands in', async () => {
  const state = newState();
  const body = await (await post(state, { uuid: uuid(9) })).json();
  assert.equal(body.blocked.name, '00000009');
});

await check('the cap is a stated number, not a silent truncation', async () => {
  const state = newState();
  for (let i = 0; i < 200; i++) {
    state.blocked.push({ server_id: 's1', uuid: `f${i}`, name: `x${i}`, created_at: t });
  }
  const res = await post(state, { uuid: uuid(1) });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'too_many');
  assert.match(body.message, /200/);
});

await check("somebody else's server is not theirs to touch", async () => {
  const state = newState();
  state.server.owner_id = 'u2';
  assert.equal((await post(state, { uuid: uuid(2) })).status, 404);
  assert.equal((await call(handleListBlocked, state, '/v1/servers/s1/blocked')).status, 404);
  assert.equal(state.blocked.length, 0);
});

await check('unblocking removes the row and rebuilds again', async () => {
  const state = newState();
  await post(state, { uuid: uuid(2) });
  state.queued.length = 0;
  const res = await call(handleUnblockPlayer, state, '/v1/servers/s1/blocked/x',
                         { method: 'DELETE' }, uuid(2));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rebuilding, true);
  assert.equal(state.blocked.length, 0);
  assert.equal(state.queued.length, 1);
});

await check('unblocking somebody who is not blocked is a 404', async () => {
  const state = newState();
  const res = await call(handleUnblockPlayer, state, '/v1/servers/s1/blocked/x',
                         { method: 'DELETE' }, uuid(2));
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error, 'not_blocked');
});

await check('search finds players by the start of their name', async () => {
  const state = newState();
  const res = await call(handleSearchPlayers, state, '/v1/servers/s1/players?q=gr');
  const { players } = await res.json();
  assert.equal(players.length, 1);
  assert.equal(players[0].name, 'Griefer');
  assert.equal(players[0].blocked, false);
});

await check('search marks the ones already blocked, rather than hiding them', async () => {
  const state = newState();
  await post(state, { uuid: uuid(2) });
  const { players } = await (await call(handleSearchPlayers, state,
                                        '/v1/servers/s1/players?q=griefer')).json();
  assert.equal(players.length, 1);
  assert.equal(players[0].blocked, true);
});

await check('an empty search asks D1 for nothing', async () => {
  const state = newState();
  const { players } = await (await call(handleSearchPlayers, state,
                                        '/v1/servers/s1/players?q=')).json();
  assert.deepEqual(players, []);
});

console.log(`\n${checks} checks passed`);
