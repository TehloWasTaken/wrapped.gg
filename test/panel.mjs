import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import worker from '../src/index.js';

const web = new URL('../web/', import.meta.url);
const read = (f) => readFileSync(new URL(f, web), 'utf8');

const env = {
  SITE_URL: 'https://wrapped.gg',
  ASSETS: {
    fetch: async (req) => {
      const p = new URL(req.url ? req.url : req).pathname;
      try { return new Response(read('.' + p), { status: 200 }); }
      catch { return new Response('missing', { status: 404 }); }
    },
  },
  ANALYTICS: { writeDataPoint() {} },
  DB: { prepare() { throw new Error('the panel shell must not touch the database'); } },
  R2: { get: async () => null },
  KV: { get: async () => null, put: async () => {} },
};

const get = (path, headers = {}) =>
  worker.fetch(new Request('https://wrapped.gg' + path, { headers }), env, { waitUntil() {} });

const signedOutSection = (html) => {
  const m = /<section id="signedOut"([^>]*)>([\s\S]*?)<\/section>/.exec(html);
  assert.ok(m, 'the panel has no signedOut section any more');
  return { attrs: m[1], body: m[2] };
};

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label); };

console.log('the signed-out panel:');

await check('renders without javascript, so a scanner sees the real page', async () => {
  const res = await get('/panel');
  assert.equal(res.status, 200);
  const { attrs } = signedOutSection(await res.text());
  assert.ok(!attrs.includes('hidden'),
    'signedOut is hidden in the markup: a crawler gets a page with a Discord logo and nothing else');
});

await check('says in the markup that it is not a Discord login form', async () => {
  const { body } = signedOutSection(await (await get('/panel')).text());
  assert.match(body, /not a Discord login form/i);
  assert.match(body, /discord\.com/);
  assert.match(body, /no password on wrapped\.gg/i);
});

await check('names the one scope it asks for and what it cannot do', async () => {
  const { body } = signedOutSection(await (await get('/panel')).text());
  assert.match(body, /<code>identify<\/code>/);
  assert.match(body, /cannot read your messages/i);
  assert.match(body, /never see your email address or your password/i);
});

await check('names its operator and disclaims both brands it borrows', async () => {
  const { body } = signedOutSection(await (await get('/panel')).text());
  assert.match(body, /not affiliated with Discord Inc\./);
  assert.match(body, /not affiliated with Mojang AB or Microsoft/);
  assert.match(body, /discord\.gg\/hPRGgWKpTF/);
});

await check('a request carrying a session hides it before the first paint', async () => {
  const res = await get('/panel', { cookie: 'wgg_session=abc123' });
  const html = await res.text();
  assert.match(html, /<body class="app signed-in">/);
  assert.match(read('panel.html'), /body\.signed-in #signedOut \{ display: none; \}/);
});

await check('a stale session cookie still gets the page back', async () => {
  const js = read('panel.html').split('<script type="module">')[1] || read('panel.html');
  assert.match(js, /classList\.toggle\('signed-in', id !== 'signedOut'\)/,
    'show() must drop the class, or a 401 leaves the user staring at a blank panel');
});

await check('is never cached once it varies on a cookie, and never framed', async () => {
  const plain = await get('/panel');
  assert.equal(plain.headers.get('cache-control'), 'private, no-store');
  assert.equal(plain.headers.get('x-frame-options'), 'DENY');

  const docs = await get('/docs');
  assert.equal(docs.headers.get('cache-control'), 'public, max-age=300');
});

await check('stays out of the index', async () => {
  const head = (await (await get('/panel')).text()).split('</head>')[0];
  assert.match(head, /<meta name="robots" content="noindex, follow"/);
});

console.log('\nthe server detail tabs:');

const panel = read('panel.html');
const script = panel.split('<script type="module">')[1];
const detail = /<section id="detail"[^>]*>([\s\S]*?)\n  <\/section>/.exec(panel)[1];

const stripTabs = [...detail.matchAll(/<button class="t"[\s\S]*?data-tab="([a-z]+)"[\s\S]*?aria-controls="pane-([a-z]+)"/g)];

const paneBodies = () => {
  const out = new Map();
  const open = /<div class="pane" id="pane-([a-z]+)"[^>]*>/g;
  let m;
  while ((m = open.exec(detail))) {
    let depth = 1, i = open.lastIndex;
    const div = /<div\b|<\/div>/g;
    div.lastIndex = i;
    let d;
    while (depth > 0 && (d = div.exec(detail))) {
      depth += d[0] === '</div>' ? -1 : 1;
      i = div.lastIndex;
    }
    out.set(m[1], detail.slice(open.lastIndex, i - '</div>'.length));
  }
  return out;
};
const panes = paneBodies();

await check('every tab in the strip points at a pane that points back', async () => {
  assert.equal(stripTabs.length, 5, 'the strip should have five tabs');
  for (const [, dataTab, controls] of stripTabs) {
    assert.equal(dataTab, controls, `tab ${dataTab} controls pane-${controls}`);
    assert.ok(panes.has(dataTab), `pane-${dataTab} is missing`);
    assert.match(detail, new RegExp(`id="pane-${dataTab}"[^>]*role="tabpanel"[^>]*aria-labelledby="tab-${dataTab}"`),
      `pane-${dataTab} must name its tab back, or a screen reader announces it as a bare div`);
  }
});

await check('the script drives the same tabs, in the same order', async () => {
  const list = /const TABS = \[([^\]]+)\]/.exec(script)[1].replace(/['\s]/g, '');
  assert.equal(list, stripTabs.map(t => t[1]).join(','),
    'TABS and the markup disagree: a tab would render with no pane behind it');
});

await check('every settings section lives inside a tab', async () => {
  let outside = detail;
  for (const body of panes.values()) outside = outside.replace(body, '');
  const loose = [...outside.matchAll(/<h2>([^<]+)<\/h2>/g)].map(m => m[1]);
  assert.deepEqual(loose, ['Need a hand'],
    'a section outside a pane is on screen on every tab - put it in one, or say why here');
});

await check('the panes nobody opened cost nothing to render', async () => {
  const openServer = /async function openServer\([\s\S]*?\n}/.exec(script)[0];
  assert.ok(!openServer.includes('loadAnalytics('),
    'openServer runs the Analytics Engine query again: it belongs to the Traffic tab');
  assert.ok(!openServer.includes('showEmbed('),
    'openServer mounts the embed iframe again: it belongs to the Embed tab');
  assert.match(script, /if \(name === 'traffic'\) loadAnalytics/);
  assert.match(script, /if \(name === 'embed'\) showEmbed/);
});

await check('a link to a tab survives a reload, and a bad one lands somewhere real', async () => {
  assert.match(script, /window\.addEventListener\('hashchange'/,
    'without this the browser back button walks off the panel');
  assert.match(script, /TABS\.includes\(m\[2\]\) \? m\[2\] : 'overview'/);
  assert.match(script, /if \(!s\) \{ current = null; renderList\(\); return; \}/,
    'a hash naming a server the user does not own must fall back to the list');
});

console.log('\nevery page:');

const pages = ['index.html', 'panel.html', 'upload.html', 'docs.html',
               'hosts.html', 'wrapped.html'];

await check('loads no third-party script', async () => {
  for (const p of pages) {
    const html = read(p);
    const external = [...html.matchAll(/<script[^>]*\ssrc="(https?:)?\/\/([^"]+)"/g)].map(m => m[2]);
    assert.deepEqual(external, [], `${p} pulls in ${external.join(', ')}`);
    assert.ok(!/gtag|dataLayer/.test(html), `${p} still has analytics glue with nothing to feed`);
  }
});

console.log(`\n${checks} checks passed`);
