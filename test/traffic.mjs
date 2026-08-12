import assert from 'node:assert';
import { serverTraffic, handleAnalytics } from '../src/api/analytics.js';

const t = Math.floor(Date.now() / 1000);
const ADMIN = '100000000000000001';

const utcDay = (back) =>
  new Date(Date.now() - back * 86400000).toISOString().slice(0, 10);

function fakeDb({ session, server }) {
  const first = async (sql, args) => {
    if (sql.includes('FROM sessions s JOIN users u')) {
      return session ? { ...session, expires_at: t + 3600 } : null;
    }
    if (sql.includes('FROM servers WHERE id')) {
      if (!server) return null;
      if (args[0] !== server.id) return null;
      if (sql.includes('owner_id = ?') && args[1] !== server.owner_id) return null;
      return server;
    }
    return null;
  };
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        first: () => first(sql, args),
        all: async () => ({ results: [] }),
        run: async () => ({ meta: { changes: 0 } }),
      };
      return stmt;
    },
  };
}

function fakeAE(rows) {
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    sent.push({ url: String(url), sql: opts.body, auth: opts.headers.authorization });
    return new Response(JSON.stringify({ data: rows }), { status: 200 });
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

const creds = { CF_ACCOUNT_ID: 'acct', CF_ANALYTICS_TOKEN: 'tok' };
const owner = { id: 'u1', discord_id: ADMIN, username: 'Ari', avatar: null };
const server = { id: 's1', slug: 'northwind', name: 'Northwind', owner_id: 'u1' };

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label); };

console.log('report:');

await check('no analytics credentials says so instead of failing', async () => {
  const spy = fakeAE([]);
  try {
    const d = await serverTraffic({}, 'northwind');
    assert.equal(d.available, false);
    assert.match(d.reason, /not configured/);
    assert.equal(spy.sent.length, 0, 'should not have called the API at all');
  } finally { spy.restore(); }
});

await check('an unreachable API is reported, not thrown', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  try {
    const d = await serverTraffic(creds, 'northwind');
    assert.equal(d.available, false);
    assert.match(d.reason, /Could not reach/);
  } finally { globalThis.fetch = real; }
});

await check('rows fold into 30 days ending today', async () => {
  const spy = fakeAE([
    { day: utcDay(2) + ' 00:00:00', name: 'page_view', kind: 'server', n: 10 },
    { day: utcDay(2) + ' 00:00:00', name: 'page_view', kind: 'player', n: 25 },
    { day: utcDay(0) + ' 00:00:00', name: 'page_view', kind: 'player', n: 5 },
    { day: utcDay(0) + ' 00:00:00', name: 'og_image',  kind: 'cached', n: 8 },
  ]);
  let d;
  try { d = await serverTraffic(creds, 'northwind'); } finally { spy.restore(); }

  assert.equal(d.available, true);
  assert.equal(d.days.length, 30);
  assert.equal(d.days[29], utcDay(0));
  assert.equal(d.days[0], utcDay(29));

  assert.equal(d.totals.views, 40);
  assert.equal(d.totals.player_views, 30);
  assert.equal(d.totals.cards, 8);
  assert.equal(d.series.views[27], 35);
  assert.equal(d.series.player_views[27], 25);
  assert.equal(d.series.views[29], 5);
  assert.equal(d.series.cards[29], 8);
  assert.equal(d.series.views[28], 0, 'a quiet day is a zero, not a gap');
});

await check('miss rate is misses over every lookup', async () => {
  const spy = fakeAE([
    { day: utcDay(1) + ' 00:00:00', name: 'player_read', kind: 'hit',  n: 30 },
    { day: utcDay(1) + ' 00:00:00', name: 'player_read', kind: 'miss', n: 10 },
  ]);
  let d;
  try { d = await serverTraffic(creds, 'northwind'); } finally { spy.restore(); }
  assert.equal(d.totals.lookups, 40);
  assert.equal(d.totals.misses, 10);
  assert.equal(d.miss_rate, 25);
});

await check('nothing recorded is zeroes, not an error', async () => {
  const spy = fakeAE([]);
  let d;
  try { d = await serverTraffic(creds, 'northwind'); } finally { spy.restore(); }
  assert.equal(d.available, true);
  assert.equal(d.totals.views, 0);
  assert.equal(d.miss_rate, 0);
  assert.equal(d.series.views.length, 30);
});

await check('days outside the window are dropped rather than counted', async () => {
  const spy = fakeAE([
    { day: utcDay(45) + ' 00:00:00', name: 'page_view', kind: 'server', n: 999 },
    { day: utcDay(1) + ' 00:00:00',  name: 'page_view', kind: 'server', n: 3 },
  ]);
  let d;
  try { d = await serverTraffic(creds, 'northwind'); } finally { spy.restore(); }
  assert.equal(d.totals.views, 3);
});

await check('a slug cannot break out of the SQL string', async () => {
  const spy = fakeAE([]);
  try { await serverTraffic(creds, "northwind' OR 1=1 --"); } finally { spy.restore(); }
  const sql = spy.sent[0].sql;
  assert.ok(sql.includes("blob2 = 'northwind11--'"), sql);
  assert.equal((sql.match(/'/g) || []).length % 2, 0);
  assert.ok(!/OR 1=1/.test(sql), sql);
});

console.log('owner door:');

await check("an owner sees their own server's traffic", async () => {
  const spy = fakeAE([{ day: utcDay(0) + ' 00:00:00', name: 'page_view', kind: 'player', n: 7 }]);
  let res;
  try {
    res = await handleAnalytics(
      new Request('https://wrapped.gg/v1/servers/s1/analytics', { headers: { cookie: 'wgg_session=sid' } }),
      { ...creds, DB: fakeDb({ session: owner, server }) }, 's1');
  } finally { spy.restore(); }
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /private/);
  const d = await res.json();
  assert.equal(d.totals.views, 7);
  assert.ok(spy.sent[0].sql.includes("blob2 = 'northwind'"));
});

await check('somebody else asking for it gets 404', async () => {
  const spy = fakeAE([]);
  let res;
  try {
    res = await handleAnalytics(
      new Request('https://wrapped.gg/v1/servers/s1/analytics', { headers: { cookie: 'wgg_session=sid' } }),
      { ...creds, DB: fakeDb({ session: { ...owner, id: 'u2' }, server }) }, 's1');
  } finally { spy.restore(); }
  assert.equal(res.status, 404);
  assert.equal(spy.sent.length, 0, 'must not query analytics for a server it refused');
});

console.log(`\n${checks} checks passed`);
