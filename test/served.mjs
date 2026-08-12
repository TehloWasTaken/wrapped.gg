import assert from 'node:assert';
import { playersServed, servedLine, SERVED_FLOOR } from '../src/api/public.js';

function fakeEnv({ cached = null, rows = [{ n: 0 }], kvThrows = false, dbThrows = false } = {}) {
  const hits = { get: 0, put: 0, query: 0 };
  let store = cached;
  return {
    hits,
    get stored() { return store; },
    KV: {
      get: async () => { hits.get++; if (kvThrows) throw new Error('kv down'); return store; },
      put: async (k, v) => { hits.put++; store = v; },
    },
    DB: {
      prepare(sql) {
        return {
          first: async () => {
            hits.query++;
            if (dbThrows) throw new Error('d1 down');
            assert.match(sql, /FROM builds WHERE is_live = 1/, 'must count live builds only');
            return rows[0];
          },
        };
      },
    },
  };
}

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label); };

console.log('count:');

await check('a cold cache asks D1 once and writes the answer back', async () => {
  const env = fakeEnv({ rows: [{ n: 9176 }] });
  assert.equal(await playersServed(env), 9176);
  assert.deepEqual(env.hits, { get: 1, put: 1, query: 1 });
  assert.equal(env.stored, '9176');
});

await check('a warm cache never touches D1', async () => {
  const env = fakeEnv({ cached: '9176', rows: [{ n: 1 }] });
  assert.equal(await playersServed(env), 9176);
  assert.equal(env.hits.query, 0, 'the whole point of the cache');
  assert.equal(env.hits.put, 0);
});

await check('a cached zero is still a cached answer, not a cache miss', async () => {
  const env = fakeEnv({ cached: '0', rows: [{ n: 500 }] });
  assert.equal(await playersServed(env), 0);
  assert.equal(env.hits.query, 0);
});

await check('KV falling over returns 0 rather than throwing', async () => {
  assert.equal(await playersServed(fakeEnv({ kvThrows: true })), 0);
});

await check('D1 falling over returns 0 rather than throwing', async () => {
  assert.equal(await playersServed(fakeEnv({ dbThrows: true })), 0);
});

await check('a NULL sum reads as 0', async () => {
  assert.equal(await playersServed(fakeEnv({ rows: [{ n: null }] })), 0);
});

console.log('line:');

await check('the number is grouped and the sentence is whole', async () => {
  const html = servedLine(9176);
  assert.ok(html.includes('<b>9,176</b>'), html);
  assert.ok(html.includes('players already have their Wrapped'), html);
  assert.ok(html.startsWith('<div class="served enter e4">'), html);
});

await check('a seven-figure count still groups', async () => {
  assert.ok(servedLine(1234567).includes('<b>1,234,567</b>'));
});

await check('it ends on a call to action, above the button', async () => {
  assert.match(servedLine(9176), /class="served-cta">[^<]+</,
               'the second line is what hands off to the button below it');
});

await check('at the floor exactly, the line shows', async () => {
  assert.notEqual(servedLine(SERVED_FLOOR), '');
});

await check('below the floor there is no line at all, not an empty box', async () => {
  assert.equal(servedLine(SERVED_FLOOR - 1), '');
  assert.equal(servedLine(0), '');
});

await check('a failed count leaves the hero exactly as it was', async () => {
  const env = fakeEnv({ dbThrows: true });
  assert.equal(servedLine(await playersServed(env)), '');
});

console.log('page:');

const { readFile } = await import('node:fs/promises');
const source = await readFile('web/index.html', 'utf8');
const render = (n) => source.replace('<!--SERVED-->', servedLine(n));

await check('the placeholder is in index.html, and only once', async () => {
  assert.equal((source.match(/<!--SERVED-->/g) || []).length, 1);
  assert.ok(source.indexOf('<!--SERVED-->') < source.indexOf('class="hero-cta'));
  assert.ok(source.indexOf('<!--SERVED-->') > source.indexOf('class="sub enter'));
  for (const cls of ['.cta-block', '.served', '.served-n', '.served-n b', '.served-cta']) {
    assert.ok(source.includes(cls + ' {') || source.includes(cls + ' ,'),
              `${cls} is emitted by servedLine and must be styled`);
  }
});

await check('the card and the buttons share one wrapper, which is what matches their width', async () => {
  const block = source.slice(source.indexOf('<div class="cta-block">'),
                             source.indexOf('class="hero-note'));
  assert.ok(block.includes('<!--SERVED-->'), 'the card must be inside the wrapper');
  assert.ok(block.includes('class="hero-cta'), 'so must the buttons');
  assert.match(source, /\.cta-block \{[^}]*width: fit-content/);
  assert.match(source, /\.served \{[^}]*width: 0; min-width: 100%/);
});

await check('the phone breakpoint stops the two chasing each other', async () => {
  const mq = source.slice(source.indexOf('@media (max-width: 560px)'));
  assert.match(mq.slice(0, 400), /\.cta-block \{ width: auto/);
});

await check('no scratch preview files are left in web/ to be deployed', async () => {
  const { readdir } = await import('node:fs/promises');
  const stray = (await readdir('web')).filter(f => f.startsWith('__'));
  assert.deepEqual(stray, [], `these would ship: ${stray.join(', ')}`);
});

await check('the line carries one number and nothing else', async () => {
  const text = servedLine(9176).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(text, '9,176 players already have their Wrapped Yours are one upload away');
  assert.deepEqual(text.match(/[\d,]+/g), ['9,176'], 'one figure on the page, not two');
});

await check('rendering changes the page in exactly one place', async () => {
  const out = render(9176);
  assert.notEqual(out, source, 'the line should have been stamped in');
  assert.equal(out.replace(servedLine(9176), '<!--SERVED-->'), source);
});

await check('no admin figure other than the player count reaches the page', async () => {
  const out = render(9176);
  for (const word of ['partner', 'snapshot', 'audit', 'usercache', 'discord_id',
                      'owner_id', 'api_key', 'claim_token', 'is_live', 'wgg_host',
                      'wgg_live', 'admin']) {
    assert.ok(!new RegExp(word, 'i').test(servedLine(9176)),
              `"${word}" must not be anywhere near the hero line`);
  }
  assert.equal(out.length, source.length - '<!--SERVED-->'.length + servedLine(9176).length);
});

await check('no page still carries the "in development" bar', async () => {
  const pages = ['index', 'panel', 'upload', 'docs', 'hosts', 'wrapped'];
  for (const p of pages) {
    const html = await readFile(`web/${p}.html`, 'utf8');
    assert.ok(!/dev-bar|IN DEVELOPMENT/i.test(html), `${p}.html still has it`);
  }
  const css = await readFile('web/assets/app.css', 'utf8');
  assert.ok(!css.includes('dev-bar'), 'app.css still styles a bar nothing renders');
});

console.log(`\n${checks} checks passed`);
