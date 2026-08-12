import assert from 'node:assert';
import { headFromSkin } from '../src/lib/skin.js';
import { handleHead } from '../src/api/heads.js';

let checks = 0;
const check = async (label, fn) => { await fn(); checks++; console.log('  ok  ' + label); };

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return (b) => {
    let c = 0xffffffff;
    for (let i = 0; i < b.length; i++) c = t[(c ^ b[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, body) {
  const out = new Uint8Array(body.length + 12);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(out.length - 4, CRC(out.subarray(4, out.length - 4)));
  return out;
}

async function makeSkin(pixels, { width = 64, height = 64, filter = 0, color = 6 } = {}) {
  const ch = color === 6 ? 4 : 3;
  const stride = width * ch;
  const raw = new Uint8Array((stride + 1) * height);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    raw[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? row[i - ch] : 0;
      const b = y ? prev[i] : 0;
      const c = y && i >= ch ? prev[i - ch] : 0;
      let v = row[i];
      if (filter === 1) v -= a;
      else if (filter === 2) v -= b;
      else if (filter === 3) v -= (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v -= pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      raw[y * (stride + 1) + 1 + i] = v & 255;
    }
    prev.set(row);
  }
  const deflated = new Uint8Array(await new Response(
    new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height);
  ihdr[8] = 8; ihdr[9] = color;
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', deflated), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

function blankSkin(color = 6) {
  const ch = color === 6 ? 4 : 3;
  const px = new Uint8Array(64 * 64 * ch);
  if (ch === 4) for (let i = 3; i < px.length; i += 4) px[i] = 255;
  return px;
}

const put = (px, x, y, [r, g, b, a = 255], ch = 4) => {
  const i = (y * 64 + x) * ch;
  px[i] = r; px[i + 1] = g; px[i + 2] = b;
  if (ch === 4) px[i + 3] = a;
};

const readPng = async (bytes) => {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) assert.equal(bytes[i], sig[i], 'not a PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 8; const idat = []; let head = null;
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const body = bytes.subarray(off + 8, off + 8 + len);
    const want = CRC(bytes.subarray(off + 4, off + 8 + len));
    assert.equal(dv.getUint32(off + 8 + len), want, `bad CRC on ${type}`);
    if (type === 'IHDR') head = { w: dv.getUint32(off + 8), h: dv.getUint32(off + 12),
                                  depth: body[8], color: body[9] };
    if (type === 'IDAT') idat.push(body);
    off += len + 12;
  }
  const merged = new Uint8Array(idat.reduce((n, p) => n + p.length, 0));
  let at = 0; for (const p of idat) { merged.set(p, at); at += p.length; }
  const raw = new Uint8Array(await new Response(
    new Blob([merged]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
  const stride = head.w * 4;
  const px = new Uint8Array(stride * head.h);
  for (let y = 0; y < head.h; y++) {
    assert.equal(raw[y * (stride + 1)], 0, 'we always write filter 0');
    px.set(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), y * stride);
  }
  return { ...head, at: (x, y) => [...px.subarray((y * head.w + x) * 4, (y * head.w + x) * 4 + 4)] };
};

console.log('cropping a skin:');

await check('the face at 8,8 becomes a 128x128 head', async () => {
  const px = blankSkin();
  put(px, 8, 8, [255, 0, 0]);
  put(px, 15, 15, [0, 0, 255]);
  const out = await readPng(await headFromSkin(await makeSkin(px)));
  assert.equal(out.w, 128);
  assert.equal(out.h, 128);
  assert.deepEqual(out.at(0, 0), [255, 0, 0, 255], 'top-left face pixel');
  assert.deepEqual(out.at(127, 127), [0, 0, 255, 255], 'bottom-right face pixel');
});

await check('every source pixel becomes a clean 16x16 block, no smoothing', async () => {
  const px = blankSkin();
  put(px, 8, 8, [255, 0, 0]);
  const out = await readPng(await headFromSkin(await makeSkin(px)));
  for (const [x, y] of [[0, 0], [15, 15], [8, 8]]) {
    assert.deepEqual(out.at(x, y), [255, 0, 0, 255], `${x},${y} should still be red`);
  }
  assert.notDeepEqual(out.at(16, 0), [255, 0, 0, 255], 'the next block is a different pixel');
});

await check('the hat layer is ignored, so the face is what you see', async () => {
  const px = blankSkin();
  put(px, 8, 8, [255, 0, 0]);
  put(px, 40, 8, [0, 255, 0]);
  const out = await readPng(await headFromSkin(await makeSkin(px)));
  assert.deepEqual(out.at(0, 0), [255, 0, 0, 255], 'the hat pixel must not cover the face');
});

console.log('the PNG formats that turn up:');

for (const filter of [0, 1, 2, 3, 4]) {
  await check(`filter ${filter} decodes to the same pixels`, async () => {
    const px = blankSkin();
    put(px, 8, 8, [10, 120, 240]);
    put(px, 9, 8, [240, 120, 10]);
    put(px, 8, 9, [7, 7, 7]);
    const out = await readPng(await headFromSkin(await makeSkin(px, { filter })));
    assert.deepEqual(out.at(0, 0), [10, 120, 240, 255]);
    assert.deepEqual(out.at(16, 0), [240, 120, 10, 255]);
    assert.deepEqual(out.at(0, 16), [7, 7, 7, 255]);
  });
}

await check('a skin with no alpha channel still works', async () => {
  const px = blankSkin(2);
  put(px, 8, 8, [1, 2, 3], 3);
  const out = await readPng(await headFromSkin(await makeSkin(px, { color: 2 })));
  assert.deepEqual(out.at(0, 0), [1, 2, 3, 255]);
});

await check('a legacy 64x32 skin is cropped, not refused', async () => {
  const px = new Uint8Array(64 * 32 * 4);
  for (let i = 3; i < px.length; i += 4) px[i] = 255;
  put(px, 8, 8, [9, 9, 9]);
  const out = await readPng(await headFromSkin(await makeSkin(px, { height: 32 })));
  assert.deepEqual(out.at(0, 0), [9, 9, 9, 255]);
});

console.log('refusing what it cannot read:');

await check('junk is refused rather than guessed at', async () => {
  for (const bad of [new Uint8Array(0), new Uint8Array([1, 2, 3]),
                     new Uint8Array(200), new TextEncoder().encode('<html>nope</html>')]) {
    assert.equal(await headFromSkin(bad), null);
  }
});

await check('a fully transparent head is treated as no skin at all', async () => {
  const px = new Uint8Array(64 * 64 * 4);
  assert.equal(await headFromSkin(await makeSkin(px)), null);
});

console.log('the endpoint:');

function headEnv({ r2 = null, kv = {}, fetcher } = {}) {
  const state = { put: null, kvPut: [] };
  const env = {
    R2: { get: async () => r2, put: async (k, v) => { state.put = [k, v]; } },
    KV: { get: async (k) => (k in kv ? kv[k] : null),
          put: async (k, v) => { state.kvPut.push([k, v]); } },
    ASSETS: { fetch: async () => new Response('STEVE', { status: 200 }) },
    ANALYTICS: null,
  };
  return { env, state, fetcher };
}

const ctx = { waitUntil: (p) => p };
const BEDROCK = '00000000-0000-0000-0009-0000083e49fc';

await check('a Bedrock uuid is resolved through Geyser and cropped, not given Steve', async () => {
  const px = blankSkin();
  put(px, 8, 8, [3, 33, 133]);
  const skin = await makeSkin(px);
  const { env, state } = headEnv();
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    if (String(url).includes('/v2/skin/')) {
      return new Response(JSON.stringify({ texture_id: 'a'.repeat(64), is_steve: false }), { status: 200 });
    }
    return new Response(skin, { status: 200 });
  };
  try {
    const res = await handleHead(new Request('https://wrapped.gg/head/x.png'), env, ctx, BEDROCK);
    const out = await readPng(new Uint8Array(await res.arrayBuffer()));
    assert.deepEqual(out.at(0, 0), [3, 33, 133, 255]);
    assert.ok(seen[0].includes('api.geysermc.org/v2/skin/2533274928695804'), seen[0]);
    assert.ok(seen[1].includes('textures.minecraft.net/texture/' + 'a'.repeat(64)), seen[1]);
    assert.ok(state.put, 'the cropped head should be cached in R2');
    assert.equal(state.put[0], `head/${BEDROCK}.png`);
  } finally { globalThis.fetch = real; }
});

await check('a Bedrock player with no skin record falls back to Steve, and is remembered', async () => {
  const { env, state } = headEnv();
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const res = await handleHead(new Request('https://wrapped.gg/head/x.png'), env, ctx, BEDROCK);
    assert.equal(await res.text(), 'STEVE');
    assert.ok(state.kvPut.some(([k, v]) => k.startsWith('bedskin:') && v === '!'),
              'a player with no skin should not be looked up on every page view');
  } finally { globalThis.fetch = real; }
});

await check('a remembered miss does not call the API again', async () => {
  const { env } = headEnv({ kv: { [`bedskin:${BEDROCK}`]: '!' } });
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return new Response('{}', { status: 200 }); };
  try {
    const res = await handleHead(new Request('https://wrapped.gg/head/x.png'), env, ctx, BEDROCK);
    assert.equal(await res.text(), 'STEVE');
    assert.equal(called, 0);
  } finally { globalThis.fetch = real; }
});

await check('a Java uuid still goes to the avatar service, not to Geyser', async () => {
  const { env } = headEnv();
  const real = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response(new Uint8Array(600), { status: 200 });
  };
  try {
    await handleHead(new Request('https://wrapped.gg/head/x.png'), env, ctx,
                     '069a79f4-44e9-4726-a5be-fca90e38aaf5');
    assert.equal(seen.length, 1);
    assert.ok(seen[0].startsWith('https://mc-heads.net/avatar/'), seen[0]);
  } finally { globalThis.fetch = real; }
});

await check('an already-cropped head comes from R2 without touching the network', async () => {
  const { env } = headEnv({ r2: { body: 'CACHED' } });
  const real = globalThis.fetch;
  let called = 0;
  globalThis.fetch = async () => { called++; return new Response('x'); };
  try {
    const res = await handleHead(new Request('https://wrapped.gg/head/x.png'), env, ctx, BEDROCK);
    assert.equal(await res.text(), 'CACHED');
    assert.equal(called, 0);
    assert.match(res.headers.get('cache-control'), /immutable/);
  } finally { globalThis.fetch = real; }
});

console.log(`\n${checks} checks passed`);
