import assert from 'node:assert';
import { handleUpdateServer } from '../src/api/servers.js';
import { stampOf } from '../src/lib/util.js';

const t = Math.floor(Date.now() / 1000);
const USER = { id: 'u1', discord_id: '100000000000000001', username: 'Ari', avatar: null };

// A fake D1 that holds one server row and applies the UPDATE it is handed.
function fakeDb(server, log) {
  const first = async (sql, args) => {
    if (sql.includes('FROM sessions s JOIN users u')) return { ...USER, expires_at: t + 3600 };
    if (sql.includes('FROM servers WHERE id = ? AND owner_id = ?')) {
      return args[0] === server.id && args[1] === server.owner_id ? { ...server } : null;
    }
    if (sql.includes('FROM servers WHERE id = ?')) return { ...server };
    if (sql.includes('FROM snapshots WHERE id = ?')) return { 1: 1 };
    return null;
  };
  const run = async (sql, args) => {
    const m = sql.match(/^UPDATE servers SET (.+) WHERE id = \?$/);
    if (m) {
      const cols = m[1].split(', ').map(c => c.split(' = ')[0]);
      log.push(cols);
      cols.forEach((col, i) => { server[col] = args[i]; });
    }
    return { meta: { changes: 1 } };
  };
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        first: () => first(sql, args),
        all: async () => ({ results: [] }),
        run: () => run(sql, args),
      };
      return stmt;
    },
  };
}

const patch = (server, body, log = []) => {
  const request = new Request(`https://wrapped.gg/v1/servers/${server.id}`, {
    method: 'PATCH',
    headers: { cookie: 'wgg_session=sid', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  // The worker's router turns a thrown Response back into one; do the same here.
  return handleUpdateServer(request, { DB: fakeDb(server, log) }, server.id)
    .catch((e) => { if (e instanceof Response) return e; throw e; });
};

const newServer = () => ({
  id: 's1', slug: 'example-k7m2p', name: 'Example SMP', description: null,
  palette: 0, owner_id: USER.id, published: 1, world_born_at: null,
  baseline_snapshot_id: null, icon_key: null, created_at: t, updated_at: t,
});

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label); };

console.log('renaming:');

await check('a new name is saved and returned', async () => {
  const s = newServer();
  const res = await patch(s, { name: 'Northwind SMP' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).name, 'Northwind SMP');
  assert.equal(s.name, 'Northwind SMP');
});

await check('surrounding whitespace is trimmed off', async () => {
  const s = newServer();
  await patch(s, { name: '  Northwind SMP \n' });
  assert.equal(s.name, 'Northwind SMP');
});

await check('the slug is left alone, so posted links keep working', async () => {
  const s = newServer();
  const log = [];
  await patch(s, { name: 'Something Else' }, log);
  assert.equal(s.slug, 'example-k7m2p');
  assert.ok(!log.flat().includes('slug'), JSON.stringify(log));
});

await check('renaming touches updated_at', async () => {
  const s = { ...newServer(), updated_at: 0 };
  await patch(s, { name: 'Northwind SMP' });
  assert.ok(s.updated_at >= t, String(s.updated_at));
});

await check('a one-character name is refused', async () => {
  const s = newServer();
  const res = await patch(s, { name: 'H' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error, 'bad_name');
  assert.equal(s.name, 'Example SMP');
});

await check('a name of nothing but spaces is refused', async () => {
  const s = newServer();
  assert.equal((await patch(s, { name: '   ' })).status, 400);
  assert.equal(s.name, 'Example SMP');
});

await check('a name past 48 characters is refused, not silently cut', async () => {
  const s = newServer();
  assert.equal((await patch(s, { name: 'x'.repeat(49) })).status, 400);
  assert.equal(s.name, 'Example SMP');
});

await check('a non-string name is refused', async () => {
  const s = newServer();
  assert.equal((await patch(s, { name: 42 })).status, 400);
  assert.equal(s.name, 'Example SMP');
});

await check('other fields still update without a name', async () => {
  const s = newServer();
  await patch(s, { published: false });
  assert.equal(s.published, 0);
  assert.equal(s.name, 'Example SMP');
});

await check("somebody else's server is not theirs to rename", async () => {
  const s = { ...newServer(), owner_id: 'u2' };
  const res = await patch(s, { name: 'Hijacked' });
  assert.equal(res.status, 404);
  assert.equal(s.name, 'Example SMP');
});

console.log('\nog cache key:');

await check('the same name stamps the same, so cards stay cached', () => {
  assert.equal(stampOf('Example SMP'), stampOf('Example SMP'));
});

await check('a rename stamps differently, so the card is drawn again', () => {
  assert.notEqual(stampOf('Example SMP'), stampOf('Northwind SMP'));
  assert.notEqual(stampOf('Example SMP'), stampOf('example smp'));
  assert.notEqual(stampOf('Example SMP'), stampOf('Example SMP '));
});

await check('a stamp is short and safe in an R2 key', () => {
  for (const n of ['Example SMP', '', 'ünïcode ✦ server', 'x'.repeat(48)]) {
    assert.match(stampOf(n), /^[a-z0-9]{1,7}$/, `${n} -> ${stampOf(n)}`);
  }
});

console.log(`\n${checks} checks passed`);
