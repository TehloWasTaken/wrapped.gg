import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { handleMetrics } from '../src/api/metrics.js';

const TOKEN = 'scrape-me';

const D1 = {
  'FROM users WHERE discord_id NOT LIKE': { n: 41 },
  'FROM users WHERE created_at': { n: 6 },
  'SUM(published)': { n: 38, pub: 18 },
  'FROM servers WHERE partner_id IS NOT NULL': { n: 5 },
  'SUM(playtime_h)': { n: 14285, hours: 902344.7 },
  'FROM builds WHERE is_live = 1': { n: 13990 },
  'SUM(bytes) AS bytes FROM snapshots': { n: 28, bytes: 481203441 },
  'FROM snapshots WHERE received_at >': { n: 3 },
  "state = ? AND received_at <": { n: 1 },
  'COUNT(*) AS n FROM builds': { n: 22 },
  'COUNT(DISTINCT server_id)': { n: 9 },
  'FROM players WHERE platform': { n: 402 },
  'FROM partners': { n: 4, revoked: 1, paused: 1 },
  'FROM claim_tokens': { n: 2 },
  'FROM usercache': { n: 1204 },
};

const STATES = [{ state: 'ready', n: 24 }, { state: 'building', n: 2 }, { state: 'failed', n: 2 }];

function fakeDb() {
  return {
    prepare(sql) {
      let args = [];
      const stmt = {
        bind: (...a) => { args = a; return stmt; },
        first: async () => {
          for (const [needle, row] of Object.entries(D1)) if (sql.includes(needle)) return row;
          throw new Error('unstubbed query: ' + sql.replace(/\s+/g, ' ').trim());
        },
        all: async () => ({ results: sql.includes('GROUP BY state') ? STATES : [] }),
      };
      return stmt;
    },
  };
}

const AE_ROWS = [
  { name: 'page_view', b2: 'northwind', b3: 'server', n: '377' },
  { name: 'page_view', b2: 'northwind', b3: 'player', n: '64' },
  { name: 'page_view', b2: 'other', b3: 'player', n: '10' },
  { name: 'player_read', b2: 'northwind', b3: 'hit', n: '288' },
  { name: 'player_read', b2: 'northwind', b3: 'miss', n: '60' },
  { name: 'og_image', b2: 'northwind', b3: 'cached', n: '114' },
  { name: 'og_image', b2: 'northwind', b3: 'rendered', n: '36' },
  { name: 'head_image', b2: 'cached', b3: '', n: '2000' },
  { name: 'head_image', b2: 'fetched', b3: '', n: '224' },
  { name: 'name_lookup', b2: 'kv', b3: '', n: '900' },
  { name: 'name_lookup', b2: 'mojang', b3: '', n: '109' },
  { name: 'snapshot_upload', b2: 'northwind', b3: 'shell', n: '14' },
  { name: 'build', b2: 'northwind', b3: 'ok', n: '29' },
  { name: 'build', b2: 'northwind', b3: 'failed', n: '8' },
];

function fakeAE(rows, { ok = true } = {}) {
  const real = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, opts) => {
    sent.push(String(opts.body));
    return ok
      ? new Response(JSON.stringify({ data: rows }), { status: 200 })
      : new Response('nope', { status: 403 });
  };
  return { sent, restore: () => { globalThis.fetch = real; } };
}

const req = (token) => new Request('https://wrapped.gg/metrics', {
  headers: token ? { authorization: `Bearer ${token}` } : {},
});

const creds = { METRICS_TOKEN: TOKEN, CF_ACCOUNT_ID: 'acct', CF_ANALYTICS_TOKEN: 'tok' };

async function scrape(env) {
  const res = await handleMetrics(req(TOKEN), { DB: fakeDb(), ...env });
  assert.equal(res.status, 200);
  return parse(await res.text());
}

function parse(text) {
  const series = new Map();
  const help = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    if (line.startsWith('# HELP ')) {
      const name = line.slice(7).split(' ')[0];
      assert.ok(!help.has(name), `HELP repeated for ${name}`);
      help.set(name, true);
      continue;
    }
    if (line.startsWith('#')) continue;
    const m = /^([a-z_0-9]+)(\{([^}]*)\})?\s+(\S+)$/.exec(line);
    assert.ok(m, `unparsable line: ${line}`);
    const labels = {};
    for (const part of (m[3] || '').split(',').filter(Boolean)) {
      const [k, v] = part.split('=');
      labels[k] = v.replace(/"/g, '');
    }
    const key = m[1] + (m[3] ? `{${m[3]}}` : '');
    assert.ok(!series.has(key), `series repeated: ${key}`);
    assert.ok(help.has(m[1]), `no HELP for ${m[1]}`);
    series.set(key, { name: m[1], labels, value: Number(m[4]) });
  }
  return series;
}

const val = (s, key) => {
  assert.ok(s.has(key), `missing series ${key}`);
  return s.get(key).value;
};

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label); };

console.log('door:');

await check('no token at all is a flat 404, the same answer an unknown path gives', async () => {
  const res = await handleMetrics(req(null), { DB: fakeDb(), ...creds });
  assert.equal(res.status, 404);
  assert.equal(await res.text(), 'Not found');
});

await check('a wrong token is the same 404, with no hint that the path exists', async () => {
  const res = await handleMetrics(req('guess'), { DB: fakeDb(), ...creds });
  assert.equal(res.status, 404);
});

await check('no METRICS_TOKEN configured means nobody can scrape it', async () => {
  const res = await handleMetrics(req(TOKEN), { DB: fakeDb() });
  assert.equal(res.status, 404);
});

console.log('exposition:');

const spy = fakeAE(AE_ROWS);
const s = await scrape(creds);
spy.restore();

await check('the D1 gauges carry the numbers the admin page would show', async () => {
  assert.equal(val(s, 'wrapped_users_total'), 41);
  assert.equal(val(s, 'wrapped_users_new_30d'), 6);
  assert.equal(val(s, 'wrapped_servers_total'), 38);
  assert.equal(val(s, 'wrapped_servers_published'), 18);
  assert.equal(val(s, 'wrapped_servers_partner_owned'), 5);
  assert.equal(val(s, 'wrapped_players_indexed'), 14285);
  assert.equal(val(s, 'wrapped_players_live'), 13990);
  assert.equal(val(s, 'wrapped_snapshots_24h'), 3);
  assert.equal(val(s, 'wrapped_snapshots_stuck'), 1);
  assert.equal(val(s, 'wrapped_claims_open'), 2);
  assert.equal(val(s, 'wrapped_usercache_entries'), 1204);
});

await check('player-hours is rounded, not handed over as a float', async () => {
  assert.equal(val(s, 'wrapped_player_hours_total'), 902345);
});

await check('every snapshot state is emitted, including the ones with no rows', async () => {
  assert.equal(val(s, 'wrapped_snapshots_by_state{state="ready"}'), 24);
  assert.equal(val(s, 'wrapped_snapshots_by_state{state="failed"}'), 2);
  assert.equal(val(s, 'wrapped_snapshots_by_state{state="building"}'), 2);
  assert.equal(val(s, 'wrapped_snapshots_by_state{state="queued"}'), 0);
});

await check('partner states add up to the partner count', async () => {
  const states = ['active', 'paused', 'revoked']
    .map(st => val(s, `wrapped_partners_by_state{state="${st}"}`));
  assert.deepEqual(states, [2, 1, 1]);
  assert.equal(states.reduce((a, b) => a + b, 0), val(s, 'wrapped_partners_total'));
});

await check('an event total is the sum of its own split', async () => {
  assert.equal(val(s, 'wrapped_page_view_24h'), 451);
  assert.equal(val(s, 'wrapped_page_view_24h_by_kind{kind="server"}'), 377);
  assert.equal(val(s, 'wrapped_page_view_24h_by_kind{kind="player"}'), 74);
});

await check('head images and name lookups take their split from blob2, not blob3', async () => {
  assert.equal(val(s, 'wrapped_head_image_24h_by_result{result="cached"}'), 2000);
  assert.equal(val(s, 'wrapped_head_image_24h_by_result{result="fetched"}'), 224);
  assert.equal(val(s, 'wrapped_head_image_24h'), 2224);
  assert.equal(val(s, 'wrapped_name_lookup_24h_by_tier{tier="kv"}'), 900);
  assert.equal(val(s, 'wrapped_name_lookup_24h_by_tier{tier="mojang"}'), 109);
});

await check('a label the window never saw is still emitted as zero', async () => {
  assert.equal(val(s, 'wrapped_name_lookup_24h_by_tier{tier="usercache"}'), 0);
  assert.equal(val(s, 'wrapped_snapshot_upload_24h_by_source{source="browser"}'), 0);
  assert.equal(val(s, 'wrapped_snapshot_upload_24h_by_source{source="shell"}'), 14);
});

await check('the interval is an integer with the unit outside the quotes', async () => {
  const spy2 = fakeAE(AE_ROWS);
  await scrape(creds);
  spy2.restore();
  assert.equal(spy2.sent.length, 2);
  for (const sql of spy2.sent) {
    assert.match(sql, /INTERVAL '\d+' DAY/,
                 `Analytics Engine rejects INTERVAL '1 DAY' with a 422: ${sql.trim()}`);
    assert.doesNotMatch(sql, /INTERVAL '\d+\s+\w+'/);
  }
  assert.ok(spy2.sent.some(s => s.includes("INTERVAL '1' DAY")));
  assert.ok(spy2.sent.some(s => s.includes("INTERVAL '30' DAY")));
});

await check('analytics reads as available, and cost follows the rendered images', async () => {
  assert.equal(val(s, 'wrapped_analytics_available'), 1);
  assert.equal(val(s, 'wrapped_est_requests_30d'), 451 * 3);
  assert.equal(val(s, 'wrapped_est_cpu_ms_30d'), 36 * 250 + 37 * 2400);
});

console.log('analytics down:');

const down = fakeAE([], { ok: false });
const s0 = await scrape(creds);
down.restore();

await check('a failed analytics query is announced rather than left to be guessed', async () => {
  assert.equal(val(s0, 'wrapped_analytics_available'), 0);
});

await check('every event series is still there, at zero, so no panel reads "No data"', async () => {
  const events = /^wrapped_(page_view|player_read|og_image|head_image|snapshot_upload|build|name_lookup)_(24h|30d)/;
  for (const key of s.keys()) {
    if (!events.test(key)) continue;
    assert.ok(s0.has(key), `series vanished when analytics failed: ${key}`);
    assert.equal(s0.get(key).value, 0, `expected 0 for ${key}`);
  }
});

await check('the D1 gauges are unaffected by analytics being down', async () => {
  assert.equal(val(s0, 'wrapped_servers_total'), 38);
  assert.equal(val(s0, 'wrapped_snapshots_by_state{state="failed"}'), 2);
});

await check('no analytics credentials is the same story as a failed query', async () => {
  const s1 = await scrape({ METRICS_TOKEN: TOKEN });
  assert.equal(val(s1, 'wrapped_analytics_available'), 0);
  assert.equal(val(s1, 'wrapped_page_view_24h'), 0);
});

console.log('dashboard:');

const dash = JSON.parse(readFileSync(new URL('../docs/monitoring/grafana-dashboard.json', import.meta.url)));
const panels = dash.panels.filter(p => p.type !== 'row');
const exprs = panels.flatMap(p => (p.targets || []).map(t => [p.title, t.expr]));
const emitted = new Set([...s.values()].map(v => v.name));

await check('every metric a panel asks for is a metric the endpoint emits', async () => {
  for (const [title, expr] of exprs) {
    for (const name of expr.match(/\bwrapped_[a-z0-9_]+/g) || []) {
      assert.ok(emitted.has(name), `panel ${title} queries ${name}, which is never emitted`);
    }
  }
});

await check('every label filter a panel uses is a label value that gets emitted', async () => {
  for (const [title, expr] of exprs) {
    for (const [, metric, label, value] of
         expr.matchAll(/\b(wrapped_[a-z0-9_]+)\{([a-z_]+)="([^"]+)"\}/g)) {
      assert.ok(s.has(`${metric}{${label}="${value}"}`),
                `panel ${title} filters ${metric} on ${label}="${value}", which is never emitted`);
    }
  }
});

await check('no ratio divides a labelled vector by a bare sum, which matches nothing', async () => {
  for (const [title, expr] of exprs) {
    if (!/\}\s*\//.test(expr)) continue;
    const divisor = expr.split('/').slice(1).join('/');
    if (!/\bsum\s*\(/.test(divisor)) continue;
    assert.ok(/scalar\s*\(|ignoring\s*\(|on\s*\(/.test(divisor),
              `panel ${title} divides a labelled series by a bare sum(): ${expr}`);
  }
});

await check('every metric the endpoint emits is on the dashboard somewhere', async () => {
  const family = (n) => n.replace(/_(24h|30d)/, '_window');
  const queried = new Set(exprs.flatMap(([, e]) => e.match(/\bwrapped_[a-z0-9_]+/g) || [])
                               .map(family));
  const orphans = [...emitted].filter(n => !queried.has(family(n)));
  assert.deepEqual(orphans, [], `emitted but never shown: ${orphans.join(', ')}`);
});

await check('no two panels sit on top of each other', async () => {
  const cells = new Set();
  for (const p of panels) {
    const { x, y, w, h } = p.gridPos;
    assert.ok(x + w <= 24, `${p.title} runs off the grid`);
    for (let i = x; i < x + w; i++) {
      for (let j = y; j < y + h; j++) {
        const key = `${i},${j}`;
        assert.ok(!cells.has(key), `${p.title} overlaps another panel at ${key}`);
        cells.add(key);
      }
    }
  }
});

console.log(`\n${checks} checks passed`);
