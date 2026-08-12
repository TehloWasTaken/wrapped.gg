function fakeD1() {
  const rows = new Map();
  let writes = 0;

  const run = (sql, args) => {
    if (sql.includes('INSERT INTO usercache')) {
      writes++;
      for (let i = 0; i < args.length; i += 6) {
        const [uuid, name, nameLower, , , updated] = args.slice(i, i + 6);
        rows.set(uuid, { uuid, name, name_lower: nameLower, updated_at: updated });
      }
      return {};
    }
    throw new Error(`fakeD1: unrecognised write: ${sql.trim().slice(0, 60)}`);
  };

  const read = (sql, args) => {
    if (sql.includes('WHERE uuid IN')) {
      return args.map(u => rows.get(u)).filter(Boolean)
        .map(r => ({ uuid: r.uuid, name: r.name }));
    }
    if (sql.includes('WHERE name_lower = ?')) {
      return [...rows.values()]
        .filter(r => r.name_lower === args[0])
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 1)
        .map(r => ({ uuid: r.uuid, name: r.name }));
    }
    throw new Error(`fakeD1: unrecognised read: ${sql.trim().slice(0, 60)}`);
  };

  return {
    prepare: (sql) => ({
      bind: (...args) => ({
        first: async () => read(sql, args)[0] ?? null,
        all: async () => ({ results: read(sql, args) }),
        run: async () => run(sql, args),
      }),
    }),
    batch: async (stmts) => Promise.all(stmts.map(s => s.run())),
    _count: () => rows.size,
    _writes: () => writes,
  };
}

function fakeKV() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => { m.set(k, v); },
    _drop: () => m.clear(),
    _size: () => m.size,
  };
}

let calls = 0;
const KNOWN = {
  '069a79f444e94726a5befca90e38aaf5': 'Notch',
  '853c80ef3c3749fdaa49938b674adae6': 'jeb_',
};
globalThis.fetch = async (url) => {
  calls++;
  const q = String(url).split('/').pop().toLowerCase();
  const uuid = KNOWN[q] ? q
    : Object.keys(KNOWN).find(u => KNOWN[u].toLowerCase() === q);
  if (!uuid) return new Response('', { status: 404 });
  return new Response(JSON.stringify({ data: { player: { username: KNOWN[uuid], raw_id: uuid } } }),
                      { status: 200, headers: { 'content-type': 'application/json' } });
};

const { namesForUuids, uuidForName, rememberNames } = await import('../src/lib/mojang.js');

let failed = 0;
const check = (label, cond, extra = '') => {
  if (cond) { console.log(`  ok   ${label}`); }
  else { failed++; console.log(`  FAIL ${label} ${extra}`); }
};

const NOTCH = '069a79f444e94726a5befca90e38aaf5';
const JEB   = '853c80ef3c3749fdaa49938b674adae6';

{
  const env = { DB: fakeD1(), KV: fakeKV() };

  calls = 0;
  let got = await namesForUuids(env, [NOTCH]);
  check('cold uuid lookup reaches the provider', calls === 1 && got.get(NOTCH) === 'Notch',
        `calls=${calls} got=${got.get(NOTCH)}`);
  check('and is written to the durable cache', env.DB._count() === 1, `n=${env.DB._count()}`);

  calls = 0;
  got = await namesForUuids(env, [NOTCH]);
  check('a warm uuid is served from KV', calls === 0 && got.get(NOTCH) === 'Notch', `calls=${calls}`);

  env.KV._drop();
  calls = 0;
  got = await namesForUuids(env, [NOTCH]);
  check('KV expiry falls through to the usercache, not the provider',
        calls === 0 && got.get(NOTCH) === 'Notch', `calls=${calls}`);
  check('and the usercache hit re-warms KV', env.KV._size() === 2, `n=${env.KV._size()}`);

  env.KV._drop();
  calls = 0;
  const uuid = await uuidForName(env, 'notch');
  check('name -> uuid is answered from the usercache too',
        calls === 0 && uuid === NOTCH, `calls=${calls} uuid=${uuid}`);
}

{
  const env = { DB: fakeD1(), KV: fakeKV() };

  const filed = await rememberNames(env, [
    ['069a79f4-44e9-4726-a5be-fca90e38aaf5', 'Notch'],
    [JEB, 'jeb_'],
    ['00000000-0000-0000-0009-01f8dcb0d7a1', 'BedrockGuy'],
    [NOTCH, ''],
    ['not-a-uuid', 'Someone'],
  ]);
  check('a viewed page files only the real Java accounts', filed === 2, `filed=${filed}`);
  check('and stores both', env.DB._count() === 2, `n=${env.DB._count()}`);

  calls = 0;
  const got = await namesForUuids(env, [NOTCH, JEB]);
  check('a filed name needs no provider call',
        calls === 0 && got.get(NOTCH) === 'Notch' && got.get(JEB) === 'jeb_', `calls=${calls}`);

  const before = env.DB._writes();
  const again = await rememberNames(env, [[NOTCH, 'Notch'], [JEB, 'jeb_']]);
  check('viewing the same page again writes nothing at all',
        again === 0 && env.DB._writes() === before, `filed=${again}`);

  env.KV._drop();
  await rememberNames(env, [[NOTCH, 'Notch']]);
  check('KV expiry costs one write, not a row', env.DB._count() === 2 &&
        env.DB._writes() === before + 1, `n=${env.DB._count()} w=${env.DB._writes()}`);
}

{
  const env = { DB: fakeD1(), KV: fakeKV() };

  await rememberNames(env, [[NOTCH, 'Notch']]);
  await namesForUuids(env, [NOTCH]);
  const before = env.DB._writes();
  await rememberNames(env, [[NOTCH, 'OldName']], null);
  check('a stale uploaded name never overwrites one we looked up',
        env.DB._writes() === before, `w=${env.DB._writes()}`);
}

{
  const env = { DB: fakeD1(), KV: fakeKV() };
  const ctx = { tasks: [], waitUntil(p) { this.tasks.push(p); } };

  const ret = rememberNames(env, [[NOTCH, 'Notch']], ctx);
  check('with a context the work is handed to waitUntil', ctx.tasks.length === 1);
  await Promise.all([ret, ...ctx.tasks]);
  check('and it still lands', env.DB._count() === 1, `n=${env.DB._count()}`);
}

{
  const env = { DB: fakeD1(), KV: fakeKV() };

  calls = 0;
  const got = await namesForUuids(env, ['ffffffffffffffffffffffffffffffff']);
  check('an unknown uuid resolves to nothing', got.size === 0 && calls === 2, `calls=${calls}`);
  check('and is not written to the usercache', env.DB._count() === 0, `n=${env.DB._count()}`);
}

{
  const broken = { prepare: () => { throw new Error('D1 is down'); }, batch: async () => { throw new Error('D1 is down'); } };
  const env = { DB: broken, KV: fakeKV() };
  calls = 0;
  const got = await namesForUuids(env, [NOTCH]);
  check('a broken usercache still renders names', got.get(NOTCH) === 'Notch', `calls=${calls}`);
  env.KV._drop();
  check('a broken usercache does not break the page that would file a name',
        await rememberNames(env, [[NOTCH, 'Notch']]) === 0);
}

console.log(failed ? `\n${failed} failed` : '\nall ok');
process.exit(failed ? 1 : 0);
