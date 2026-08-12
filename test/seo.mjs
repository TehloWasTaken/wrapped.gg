import assert from 'node:assert';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { handleSitemap, metaTags } from '../src/api/public.js';

const web = new URL('../web/', import.meta.url);
const read = (f) => readFileSync(new URL(f, web), 'utf8');
const pages = readdirSync(web).filter(f => f.endsWith('.html'));

const INDEXABLE = ['index.html', 'docs.html', 'hosts.html'];
const PATHS = { 'index.html': '/', 'docs.html': '/docs', 'hosts.html': '/hosts' };

const head = (h) => h.split('</head>')[0];
const tag = (h, re) => { const m = re.exec(h); return m ? m[1] : null; };
const title = (h) => tag(head(h), /<title>([\s\S]*?)<\/title>/);
const desc = (h) => tag(head(h), /<meta name="description" content="([^"]*)"/);
const canon = (h) => tag(head(h), /<link rel="canonical" href="([^"]*)"/);
const robots = (h) => tag(head(h), /<meta name="robots" content="([^"]*)"/);
const ld = (h) => [...h.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map(m => JSON.parse(m[1]));

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label); };

console.log('crawlable pages:');

await check('every indexable page has a title inside what Google will render', async () => {
  for (const f of INDEXABLE) {
    const t = title(read(f));
    assert.ok(t, `${f} has no title`);
    assert.ok(t.length >= 25 && t.length <= 70, `${f} title is ${t.length} chars: ${t}`);
  }
});

await check('titles are unique, so no two pages compete for the same result', async () => {
  const seen = new Map();
  for (const f of INDEXABLE) {
    const t = title(read(f));
    assert.ok(!seen.has(t), `${f} and ${seen.get(t)} share the title ${t}`);
    seen.set(t, f);
  }
});

await check('the home page leads with what people actually search for', async () => {
  const t = title(read('index.html')).toLowerCase();
  assert.ok(t.startsWith('minecraft server wrapped'),
            `the head term should open the title, got: ${t}`);
});

await check('descriptions exist and fit in a snippet', async () => {
  for (const f of INDEXABLE) {
    const d = desc(read(f));
    assert.ok(d, `${f} has no description`);
    assert.ok(d.length >= 70 && d.length <= 185, `${f} description is ${d.length} chars`);
  }
});

await check('every indexable page carries a self-referencing https canonical', async () => {
  for (const f of pages) {
    const h = read(f);
    if (f === 'wrapped.html') continue;
    const c = canon(h);
    const indexable = !/noindex/.test(robots(h) || '');
    if (indexable) assert.ok(c, `${f} is indexable but has no canonical`);
    if (c) assert.ok(c.startsWith('https://wrapped.gg'), `${f} canonical is not https: ${c}`);
    if (PATHS[f]) assert.equal(c, 'https://wrapped.gg' + PATHS[f]);
  }
});

await check('nothing anywhere points at http://', async () => {
  for (const f of pages) {
    const bad = [...read(f).matchAll(/http:\/\/(?!www\.w3\.org|localhost|schema\.org)[^\s"'<]+/g)];
    assert.deepEqual(bad.map(m => m[0]), [], `${f} links to http`);
  }
});

await check('the app pages say noindex rather than being hidden by robots.txt', async () => {
  for (const f of ['panel.html', 'upload.html']) {
    assert.match(robots(read(f)) || '', /noindex/, `${f} should be noindex`);
  }
  const txt = read('robots.txt');
  for (const p of ['/panel', '/upload']) {
    assert.ok(!txt.includes(`Disallow: ${p}`),
              `robots.txt blocks ${p}, so crawlers can never see its noindex`);
  }
});

await check('robots.txt still closes the doors that are not for crawlers', async () => {
  const txt = read('robots.txt');
  for (const p of ['/v1/', '/metrics', '/auth/', '/claim/']) {
    assert.ok(txt.includes(`Disallow: ${p}`), `robots.txt should disallow ${p}`);
  }
  assert.ok(txt.includes('Sitemap: https://wrapped.gg/sitemap.xml'));
});

await check('the answer engines are named explicitly, not left to the default', async () => {
  const txt = read('robots.txt');
  for (const ua of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) {
    assert.ok(txt.includes(`User-agent: ${ua}`), `robots.txt does not name ${ua}`);
  }
});

console.log('icons:');

await check('an icon at 48px or better is offered, which is what Google picks from', async () => {
  for (const f of INDEXABLE) {
    const sizes = [...head(read(f)).matchAll(/<link rel="icon"[^>]*sizes="(\d+)x\1"/g)]
      .map(m => Number(m[1]));
    assert.ok(sizes.some(s => s >= 48 && s % 48 === 0),
              `${f} offers only ${sizes.join(', ')}px icons`);
  }
  for (const f of ['icon-48.png', 'icon-96.png', 'icon-192.png', 'icon-512.png']) {
    assert.ok(existsSync(new URL(f, web)), `${f} is missing`);
  }
});

console.log('structured data:');

const graphOf = (f) => {
  const blocks = ld(read(f));
  assert.equal(blocks.length, 1, `${f} should carry exactly one JSON-LD block`);
  return blocks[0]['@graph'];
};

await check('each page ships exactly one graph, and it parses', async () => {
  for (const f of INDEXABLE) assert.ok(Array.isArray(graphOf(f)), `${f} has no @graph`);
});

await check('the home page declares the entity, the site and the product', async () => {
  const types = graphOf('index.html').map(n => n['@type']);
  for (const t of ['Organization', 'WebSite', 'SoftwareApplication', 'WebPage', 'FAQPage']) {
    assert.ok(types.includes(t), `home page graph is missing ${t}`);
  }
});

await check('the sub-pages carry breadcrumbs back to the home page', async () => {
  for (const f of ['docs.html', 'hosts.html']) {
    const bc = graphOf(f).find(n => n['@type'] === 'BreadcrumbList');
    assert.ok(bc, `${f} has no BreadcrumbList`);
    assert.equal(bc.itemListElement[0].item, 'https://wrapped.gg/');
    assert.equal(bc.itemListElement[1].item, 'https://wrapped.gg' + PATHS[f]);
  }
});

await check('every marked-up question is a question a reader can actually see', async () => {
  for (const f of ['index.html', 'hosts.html']) {
    const html = read(f);
    const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ');
    const faq = graphOf(f).find(n => n['@type'] === 'FAQPage');
    assert.ok(faq && faq.mainEntity.length >= 5, `${f} FAQ is too thin`);
    for (const q of faq.mainEntity) {
      const needle = q.name.replace(/\s+/g, ' ').trim();
      assert.ok(text.replace(/\s+/g, ' ').includes(needle),
                `${f} marks up a question that is not on the page: ${needle}`);
      assert.ok(q.acceptedAnswer.text.length > 40, `answer too short: ${needle}`);
    }
  }
});

await check('the price we claim in schema is the price on the page', async () => {
  const app = graphOf('index.html').find(n => n['@type'] === 'SoftwareApplication');
  assert.equal(app.offers.price, '0');
  assert.equal(app.isAccessibleForFree, true);
});

await check('the award count in schema matches the award table', async () => {
  const stats = (await import('../src/build/stats.js')).default;
  const app = graphOf('index.html').find(n => n['@type'] === 'SoftwareApplication');
  const claimed = /(\d+) ranked awards/.exec(JSON.stringify(app));
  assert.ok(claimed, 'no award count claimed in schema');
  assert.equal(Number(claimed[1]), stats.length,
               `schema says ${claimed[1]} awards, stats.js defines ${stats.length}`);
  assert.ok(desc(read('index.html')).includes(`${stats.length} ranked awards`));
});

console.log('sitemap:');

function fakeEnv(rows) {
  return {
    SITE_URL: 'https://wrapped.gg',
    KV: { get: async () => null, put: async () => {} },
    DB: {
      prepare() {
        const stmt = { bind: () => stmt, all: async () => ({ results: rows }) };
        return stmt;
      },
    },
  };
}

const built = Math.floor(Date.parse('2026-08-01T12:00:00Z') / 1000);
const xml = await (await handleSitemap(
  new Request('https://wrapped.gg/sitemap.xml'),
  fakeEnv([{ slug: 'bobs-smp-k7m2p', built_at: built },
           { slug: 'northwind-a1b2c', built_at: built - 86400 }]))).text();

await check('published servers are in the sitemap, with the day they were last built', async () => {
  assert.ok(xml.includes('<loc>https://wrapped.gg/bobs-smp-k7m2p</loc>'));
  assert.ok(xml.includes('<lastmod>2026-08-01</lastmod>'));
  assert.ok(xml.includes('<loc>https://wrapped.gg/northwind-a1b2c</loc>'));
  assert.ok(xml.includes('<lastmod>2026-07-31</lastmod>'));
});

await check('the three static pages are still listed, home page first', async () => {
  for (const p of ['https://wrapped.gg/', 'https://wrapped.gg/docs', 'https://wrapped.gg/hosts']) {
    assert.ok(xml.includes(`<loc>${p}</loc>`), `sitemap is missing ${p}`);
  }
  assert.ok(xml.indexOf('https://wrapped.gg/</loc>') < xml.indexOf('/docs</loc>'));
});

await check('nothing that is noindex is advertised in the sitemap', async () => {
  for (const p of ['/panel', '/upload', '/claim']) {
    assert.ok(!xml.includes(`<loc>https://wrapped.gg${p}</loc>`), `sitemap lists ${p}`);
  }
});

await check('a database that will not answer still returns a valid sitemap', async () => {
  const broken = fakeEnv([]);
  broken.DB.prepare = () => { throw new Error('D1 down'); };
  const res = await handleSitemap(new Request('https://wrapped.gg/sitemap.xml'), broken);
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /application\/xml/);
  assert.ok(body.includes('https://wrapped.gg/docs'));
});

console.log('tenant pages:');

await check('a server page invites indexing and a player page politely does not', async () => {
  const server = metaTags({ siteUrl: 'https://wrapped.gg', slug: 'bobs-smp', serverName: "Bob's SMP", palette: 0 });
  const player = metaTags({ siteUrl: 'https://wrapped.gg', slug: 'bobs-smp', playerName: 'Notch', serverName: "Bob's SMP", palette: 0 });
  assert.match(server, /<meta name="robots" content="index, follow/);
  assert.match(player, /<meta name="robots" content="noindex, follow/);
  assert.match(server, /<link rel="canonical" href="https:\/\/wrapped\.gg\/bobs-smp"/);
  assert.match(player, /<link rel="canonical" href="https:\/\/wrapped\.gg\/bobs-smp\/Notch"/);
});

console.log(`\n${checks} checks passed`);
