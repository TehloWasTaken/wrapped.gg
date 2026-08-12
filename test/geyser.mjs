import assert from 'node:assert';
import { isFloodgateUuid, platformOf, fallbackName, isFallbackName, xuidOf, floodgateUuid } from '../src/lib/util.js';
import { namesForUuids, uuidForName } from '../src/lib/mojang.js';
import { handleServerData } from '../src/api/public.js';

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label); };

const xuid = (hex) => `00000000-0000-0000-${hex.slice(0, 4)}-${hex.slice(4)}`;

console.log('who is a Bedrock player:');

await check('a Floodgate uuid is zero in its top 64 bits, whatever the xuid is', async () => {
  for (const hex of ['000901f1c1b2d3e4', '000a01f1c1b2d3e4', '005c6d0b12345678',
                     '0064000000000001', '0001000000000001']) {
    assert.ok(isFloodgateUuid(xuid(hex)), `${xuid(hex)} should read as Bedrock`);
    assert.equal(platformOf(xuid(hex)), 'bedrock');
  }
});

await check('the old check only caught xuids starting 0009, which is most but not all', async () => {
  const old = (u) => !u.replace(/-/g, '').startsWith('00000000000000000009');
  const missed = xuid('000a01f1c1b2d3e4');
  assert.ok(old(missed), 'this is the uuid the old rule called Java');
  assert.ok(isFloodgateUuid(missed), 'and the new rule calls it Bedrock');
});

await check('a Java uuid is left alone', async () => {
  for (const u of ['069a79f4-44e9-4726-a5be-fca90e38aaf5',
                   '853c80ef-3c37-49fd-aa49-938b674adae6']) {
    assert.ok(!isFloodgateUuid(u));
    assert.equal(platformOf(u), 'java');
  }
});

await check('the nil uuid is nobody, not a Bedrock player', async () => {
  assert.ok(!isFloodgateUuid('00000000-0000-0000-0000-000000000000'));
});

await check('junk is not a Bedrock player either', async () => {
  for (const u of ['', null, undefined, 'hello', '00000000-0000-0000-0009']) {
    assert.ok(!isFloodgateUuid(u), `${u} should not read as Bedrock`);
  }
});

console.log('what an unnamed player is called:');

await check('two different Bedrock players never collapse to the same name', async () => {
  const a = fallbackName(xuid('000901f1c1b2d3e4'));
  const b = fallbackName(xuid('0009ffffffffffff'));
  assert.notEqual(a, b, 'this is the bug: every Bedrock player showed as 00000000');
  assert.ok(a.startsWith('Bedrock-'), a);
  assert.ok(b.startsWith('Bedrock-'), b);
});

await check('the label is stable, so it does not change between builds', async () => {
  const u = xuid('000901f1c1b2d3e4');
  assert.equal(fallbackName(u), fallbackName(u.toUpperCase()));
  assert.equal(fallbackName(u), fallbackName(u.replace(/-/g, '')));
});

await check('a Java player with no name still falls back to their uuid', async () => {
  assert.equal(fallbackName('069a79f4-44e9-4726-a5be-fca90e38aaf5'), '069a79f4');
});

await check('the name already stored for 2,304 players is recognised as no name at all', async () => {
  const u = xuid('000901f1c1b2d3e4');
  assert.ok(isFallbackName('00000000', u), 'the legacy fallback must read as nameless');
  assert.ok(isFallbackName(fallbackName(u), u), 'and so must the new one');
  assert.ok(isFallbackName('', u));
  assert.ok(!isFallbackName('.AbbieIshawt', u), 'a real Geyser name is a name');
  assert.ok(!isFallbackName('Notch', '069a79f4-44e9-4726-a5be-fca90e38aaf5'));
});

console.log('never asking Mojang about a Bedrock account:');

await check('a Bedrock account is never sent to the Java providers', async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return new Response('{}', { status: 404 }); };
  const env = {
    KV: { get: async () => null, put: async () => {} },
    DB: { prepare() { const s = { bind: () => s, all: async () => ({ results: [] }),
                                 first: async () => null, run: async () => ({}) }; return s; } },
    ANALYTICS: null,
  };
  try {
    await namesForUuids(env, [xuid('000901f1c1b2d3e4'), xuid('000a01f1c1b2d3e4')]);
    const java = calls.filter(u => u.includes('playerdb') || u.includes('ashcon'));
    assert.deepEqual(java, [], `asked a Java provider about a Bedrock account: ${java[0]}`);
    assert.equal(calls.length, 2, 'both should have gone to Geyser instead');
    assert.ok(calls.every(u => u.includes('api.geysermc.org')));
  } finally { globalThis.fetch = real; }
});

await check('the xuid handed to Geyser is the low 64 bits of the uuid', async () => {
  assert.equal(xuidOf('00000000-0000-0000-0009-0000083e49fc'), '2533274928695804');
  assert.equal(floodgateUuid('2533274928695804'), '00000000-0000-0000-0009-0000083e49fc');
  assert.equal(xuidOf('069a79f4-44e9-4726-a5be-fca90e38aaf5'), null);
  assert.equal(floodgateUuid('0'), null);
});

console.log('the leaderboard a player actually sees:');

const summary = {
  leaderboards: {
    playtime: [
      { rank: 1, uuid: xuid('000901f1c1b2d3e4'), name: '00000000', value: 1434072 },
      { rank: 2, uuid: xuid('0009aaaaaaaaaaaa'), name: '00000000', value: 900000 },
      { rank: 3, uuid: xuid('0009bbbbbbbbbbbb'), name: '.AbbieIshawt', value: 800000 },
      { rank: 4, uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5', name: 'Notch', value: 700000 },
    ],
  },
};

function fakeEnv() {
  return {
    KV: { get: async () => null, put: async () => {} },
    R2: { get: async () => ({ json: async () => JSON.parse(JSON.stringify(summary)) }) },
    DB: {
      prepare(sql) {
        const s = {
          bind: () => s,
          all: async () => ({ results: [] }),
          first: async () => (sql.includes('FROM servers s')
            ? { id: 's1', slug: 'northwind', name: 'Northwind', published: 1, build_id: 'b1', palette: 0 }
            : null),
        };
        return s;
      },
    },
    ANALYTICS: null,
  };
}

const body = await (await handleServerData(
  new Request('https://wrapped.gg/v1/s/northwind'), fakeEnv(), 'northwind')).json();
const board = body.summary.leaderboards.playtime;

await check('rows stored as 00000000 come back as distinct Bedrock labels', async () => {
  assert.notEqual(board[0].name, '00000000');
  assert.notEqual(board[1].name, '00000000');
  assert.notEqual(board[0].name, board[1].name, 'two players must not share a name');
  assert.ok(board[0].name.startsWith('Bedrock-'), board[0].name);
});

await check('a Geyser player who is in usercache keeps the name they chose', async () => {
  assert.equal(board[2].name, '.AbbieIshawt');
});

await check('Java players are untouched', async () => {
  assert.equal(board[3].name, 'Notch');
});

console.log('resolving a real gamertag:');

function resolverEnv({ kv = {}, cache = [], onFetch } = {}) {
  const puts = [];
  return {
    puts,
    KV: {
      get: async (k) => (k in kv ? kv[k] : null),
      put: async (k, v) => { puts.push([k, v]); },
    },
    DB: {
      prepare(sql) {
        const s = {
          bind: (...a) => { s.args = a; return s; },
          all: async () => ({ results: sql.includes('FROM usercache') ? cache : [] }),
          first: async () => (sql.includes('FROM usercache') ? cache[0] || null : null),
          run: async () => { puts.push(['d1', s.args]); return {}; },
        };
        return s;
      },
    },
    ANALYTICS: null,
  };
}

function spyFetch(handler) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push(String(url)); return handler(String(url), opts); };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const BEDROCK = '00000000-0000-0000-0009-0000083e49fc';
const XUID = '2533274928695804';

await check('a Bedrock uuid is turned into its xuid and asked of the Geyser API', async () => {
  const spy = spyFetch(async (url) => (url.endsWith(`/gamertag/${XUID}`)
    ? new Response(JSON.stringify({ gamertag: 'Tyviebrock' }), { status: 200 })
    : new Response('nope', { status: 404 })));
  try {
    const out = await namesForUuids(resolverEnv(), [BEDROCK]);
    assert.equal(out.get(BEDROCK), 'Tyviebrock');
    assert.equal(spy.calls.length, 1);
    assert.equal(spy.calls[0], `https://api.geysermc.org/v2/xbox/gamertag/${XUID}`);
  } finally { spy.restore(); }
});

await check('a gamertag with a space survives, because Xbox allows them', async () => {
  const spy = spyFetch(async () =>
    new Response(JSON.stringify({ gamertag: 'Cool Guy 42' }), { status: 200 }));
  try {
    const out = await namesForUuids(resolverEnv(), [BEDROCK]);
    assert.equal(out.get(BEDROCK), 'Cool Guy 42');
  } finally { spy.restore(); }
});

await check('the 503 the API returns for an unknown xuid is a miss, not a retry forever', async () => {
  const spy = spyFetch(async () => new Response(
    JSON.stringify({ message: 'Unable to find user in our cache.' }), { status: 503 }));
  const env = resolverEnv();
  try {
    const out = await namesForUuids(env, [BEDROCK]);
    assert.equal(out.size, 0);
    assert.ok(env.puts.some(([k, v]) => String(k).startsWith('mcname:') && v === '!'),
              'a miss should be remembered briefly so we stop asking');
  } finally { spy.restore(); }
});

await check('nonsense from the API is refused rather than shown to players', async () => {
  for (const tag of ['', null, '.dotted', 'a gamertag far too long to be real']) {
    const spy = spyFetch(async () => new Response(JSON.stringify({ gamertag: tag }), { status: 200 }));
    try {
      const out = await namesForUuids(resolverEnv(), [BEDROCK]);
      assert.equal(out.size, 0, `accepted ${JSON.stringify(tag)} as a gamertag`);
    } finally { spy.restore(); }
  }
});

await check('a cached name is never re-fetched', async () => {
  const spy = spyFetch(async () => { throw new Error('should not be called'); });
  try {
    const env = resolverEnv({ kv: { [`mcname:v4:${BEDROCK.replace(/-/g, '')}`]: 'Tyviebrock' } });
    const out = await namesForUuids(env, [BEDROCK]);
    assert.equal(out.get(BEDROCK), 'Tyviebrock');
    assert.deepEqual(spy.calls, []);
  } finally { spy.restore(); }
});

await check('Java and Bedrock in one batch each go to their own provider', async () => {
  const spy = spyFetch(async (url) => (url.includes('geysermc')
    ? new Response(JSON.stringify({ gamertag: 'Tyviebrock' }), { status: 200 })
    : new Response(JSON.stringify({ data: { player: { username: 'Notch', raw_id: '069a79f444e94726a5befca90e38aaf5' } } }), { status: 200 })));
  try {
    const java = '069a79f4-44e9-4726-a5be-fca90e38aaf5';
    const out = await namesForUuids(resolverEnv(), [BEDROCK, java]);
    assert.equal(out.get(BEDROCK), 'Tyviebrock');
    assert.equal(out.get(java), 'Notch');
    assert.equal(spy.calls.filter(u => u.includes('geysermc')).length, 1);
    assert.equal(spy.calls.filter(u => u.includes('playerdb')).length, 1);
  } finally { spy.restore(); }
});

console.log('looking yourself up by gamertag:');

await check('a gamertag resolves back to the Floodgate uuid it belongs to', async () => {
  const spy = spyFetch(async (url) => (url.includes('/xuid/')
    ? new Response(JSON.stringify({ xuid: Number(XUID) }), { status: 200 })
    : new Response('no', { status: 404 })));
  try {
    const uuid = await uuidForName(resolverEnv(), 'Tyviebrock');
    assert.equal(uuid, BEDROCK.replace(/-/g, ''));
    assert.ok(spy.calls.some(u => u.includes('/xbox/xuid/Tyviebrock')),
              'a gamertag that looks like a Java name must still reach Geyser');
    assert.ok(spy.calls.some(u => u.includes('playerdb')),
              'and the Java providers get asked first, because most names are Java');
  } finally { spy.restore(); }
});

await check('a name with a space is looked up as a gamertag, not refused outright', async () => {
  const spy = spyFetch(async () => new Response(JSON.stringify({ xuid: Number(XUID) }), { status: 200 }));
  try {
    assert.ok(await uuidForName(resolverEnv(), 'Cool Guy 42'));
    assert.ok(spy.calls[0].includes('Cool%20Guy%2042'));
  } finally { spy.restore(); }
});

await check('a Java name still goes to the Java providers', async () => {
  const spy = spyFetch(async () => new Response(
    JSON.stringify({ data: { player: { username: 'Notch', raw_id: '069a79f444e94726a5befca90e38aaf5' } } }),
    { status: 200 }));
  try {
    await uuidForName(resolverEnv(), 'Notch');
    assert.ok(spy.calls.every(u => !u.includes('geysermc')), 'Notch is not a gamertag');
  } finally { spy.restore(); }
});

console.log(`\n${checks} checks passed`);
