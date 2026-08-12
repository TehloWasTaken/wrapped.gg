import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import worker from '../src/index.js';
import { embedTags } from '../src/api/public.js';

const web = new URL('../web/', import.meta.url);
const read = (f) => readFileSync(new URL(f, web), 'utf8');

const t = Math.floor(Date.now() / 1000);

const SERVER = {
  id: 's1', slug: 'northwind-a1b2c', name: 'Northwind SMP', description: 'A vanilla year',
  palette: 3, published: 1, icon_key: 'logo/s1/abc.png', world_born_at: null,
  build_id: 'b1', players: 3244, built_at: t - 3600,
};

function makeEnv({ server = SERVER, points = [] } = {}) {
  return {
    SITE_URL: 'https://wrapped.gg',
    ASSETS: {
      fetch: async (req) => {
        const p = new URL(req.url ? req.url : req).pathname;
        try { return new Response(read('.' + p), { status: 200 }); }
        catch { return new Response('missing', { status: 404 }); }
      },
    },
    ANALYTICS: { writeDataPoint: (d) => points.push(d) },
    DB: {
      prepare(sql) {
        let args = [];
        const stmt = {
          bind: (...a) => { args = a; return stmt; },
          first: async () => {
            if (sql.includes('FROM servers s')) {
              return server && args[0] === server.slug ? { ...server } : null;
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => ({ meta: { changes: 0 } }),
        };
        return stmt;
      },
    },
    R2: { get: async () => null },
    KV: { get: async () => null, put: async () => {} },
  };
}

const get = (path, env) =>
  worker.fetch(new Request('https://wrapped.gg' + path), env, { waitUntil() {} });

const bootOf = (html) => {
  const m = /window\.__WGG__=(\{[\s\S]*?\});/.exec(html);
  assert.ok(m, 'no boot blob in the page');
  return JSON.parse(m[1]);
};

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label); };

console.log('the embedded page:');

await check('is the same story shell, told to run in embed mode', async () => {
  const res = await get('/embed/northwind-a1b2c', makeEnv());
  assert.equal(res.status, 200);
  const html = await res.text();
  const boot = bootOf(html);
  assert.equal(boot.embed, true);
  assert.equal(boot.slug, 'northwind-a1b2c');
  assert.equal(boot.server.name, 'Northwind SMP');
  assert.ok(html.includes("classList.add('embed')"), 'the page never gets the embed class');
  assert.ok(html.includes('/assets/wrapped.js'), 'the embed should run the real story script');
});

await check('the plain page is untouched by any of it', async () => {
  const res = await get('/northwind-a1b2c', makeEnv());
  const html = await res.text();
  assert.equal(bootOf(html).embed, false);
  assert.ok(html.includes('og:image'), 'the real page still carries its unfurl');
  assert.equal(res.headers.get('content-security-policy'), null);
});

await check('keeps itself out of search and out of unfurls', async () => {
  const html = await (await get('/embed/northwind-a1b2c', makeEnv())).text();
  const head = html.split('</head>')[0];
  assert.match(head, /<meta name="robots" content="noindex, nofollow"/);
  assert.ok(!head.includes('og:image'), 'an embed must not advertise its own card');
  assert.ok(!head.includes('rel="canonical"'), 'an embed is not a page of its own');
});

await check('lets any site frame it, and says so in a header', async () => {
  const res = await get('/embed/northwind-a1b2c', makeEnv());
  assert.equal(res.headers.get('content-security-policy'), 'frame-ancestors *');
  assert.equal(res.headers.get('x-frame-options'), null);
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
});

await check('the app pages refuse to be framed at all', async () => {
  for (const p of ['/panel', '/panel.html', '/upload', '/docs', '/hosts']) {
    const res = await get(p, makeEnv());
    assert.equal(res.headers.get('x-frame-options'), 'DENY', `${p} can be framed`);
  }
});

await check('and the asset server cannot answer those paths before the worker does', async () => {
  let toml;
  for (const name of ['../wrangler.toml', '../wrangler.toml.example']) {
    try { toml = readFileSync(new URL(name, import.meta.url), 'utf8'); break; } catch {}
  }
  assert.ok(toml, 'no wrangler.toml or wrangler.toml.example to read');
  const list = /run_worker_first\s*=\s*\[([\s\S]*?)\]/.exec(toml);
  assert.ok(list, 'no run_worker_first in it');
  const first = [...list[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
  for (const p of ['/panel', '/panel.html', '/upload', '/upload.html',
                   '/docs', '/docs.html', '/hosts', '/hosts.html']) {
    assert.ok(first.includes(p),
      `${p} is not in run_worker_first, so web/${p.replace(/^\//, '') || 'index'}.html ` +
      'is served by the asset binding and never gets the header');
  }
});

await check('a slug with nothing published answers in the box, not with a browser error', async () => {
  const res = await get('/embed/northwind-a1b2c', makeEnv({ server: { ...SERVER, published: 0 } }));
  assert.equal(res.status, 404);
  assert.equal(res.headers.get('content-security-policy'), 'frame-ancestors *');
  const html = await res.text();
  assert.match(html, /Nothing here yet/);
  assert.match(html, /northwind-a1b2c/);
});

await check('a player link opens on that player', async () => {
  const html = await (await get('/embed/northwind-a1b2c/Notch', makeEnv())).text();
  const boot = bootOf(html);
  assert.equal(boot.player, 'Notch');
  assert.equal(boot.embed, true);
});

await check('an unknown slug shape is a flat 404, not a page', async () => {
  const res = await get('/embed/Not_A_Slug!/x', makeEnv());
  assert.equal(res.status, 404);
});

console.log('counting it:');

await check('a view through an embed is a view, labelled as one', async () => {
  const points = [];
  await get('/embed/northwind-a1b2c', makeEnv({ points }));
  assert.equal(points.length, 1);
  assert.deepEqual(points[0].blobs, ['page_view', 'northwind-a1b2c', 'server', 'embed']);
});

await check('the same page on wrapped.gg is labelled as itself', async () => {
  const points = [];
  await get('/northwind-a1b2c/Notch', makeEnv({ points }));
  assert.deepEqual(points[0].blobs, ['page_view', 'northwind-a1b2c', 'player', 'site']);
});

console.log('the loader:');

await check('/embed.js is javascript, cached, and readable from any site', async () => {
  const res = await get('/embed.js', makeEnv());
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /javascript/);
  assert.match(res.headers.get('cache-control'), /max-age=3600/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(await res.text(), /data-wrapped/);
});

await check('/embed on its own sends you to the guide', async () => {
  const res = await get('/embed', makeEnv());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/docs#embed');
});

await check('it ignores messages that did not come from wrapped.gg', async () => {
  const js = read('assets/embed.js');
  assert.match(js, /e\.origin !== ORIGIN/);
  assert.match(js, /d\.source !== 'wrapped\.gg'/);
});

await check('it stays the size the docs promise, on disk and on the wire', async () => {
  const src = read('assets/embed.js');
  const bytes = Buffer.byteLength(src);
  const wire = gzipSync(src).length;
  assert.ok(bytes < 5120, `embed.js is ${bytes} bytes, docs say about 4 KB`);
  assert.ok(wire < 2048, `embed.js gzips to ${wire} bytes, docs say about 1.5 KB`);
});

console.log('the surfaces agree:');

await check('panel, docs and loader all use the same attribute', async () => {
  for (const f of ['panel.html', 'docs.html']) {
    assert.match(read(f), /data-wrapped/, `${f} does not mention data-wrapped`);
  }
  assert.match(read('docs.html'), /wrapped\.gg\/embed\.js/);
  assert.match(read('panel.html'), /\/embed\.js/);
  assert.match(read('llms.txt'), /data-wrapped/);
});

await check('the embed head carries the palette accent and nothing to share', async () => {
  const tags = embedTags({ serverName: 'Northwind & Co', palette: 3 });
  assert.match(tags, /<title>Northwind &amp; Co - Wrapped<\/title>/);
  assert.match(tags, /theme-color" content="#5ded8f"/);
  assert.ok(!tags.includes('og:'));
});

console.log(`\n${checks} checks passed`);
