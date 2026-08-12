// Must be satori/standalone with an explicit init(). Workers won't compile
// wasm at runtime and satori's normal entry point does exactly that on import.
// Same for initWasm. Don't tidy these imports up.
import satori, { init as initYoga } from 'satori/standalone';
import yogaWasm from 'satori/yoga.wasm';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import resvgWasm from '@resvg/resvg-wasm/index_bg.wasm';
import { liveServer, findPlayer, readPlayerDoc } from '../api/public.js';
import { trackOgRender } from '../lib/metrics.js';
import { worldAge } from '../lib/birthday.js';
import { W, H, PALETTES, playerTemplate, serverTemplate } from './template.js';
import { stampOf } from '../lib/util.js';

let wasmReady = null;
async function ensureWasm() {
  if (!wasmReady) wasmReady = initWasm(resvgWasm);
  await wasmReady;
}

let yogaStarted = false;
function ensureYoga() {
  if (yogaStarted) return;
  yogaStarted = true;
  initYoga(yogaWasm);
}

// satori won't fetch anything, so the logo has to go in as a data URI
async function logoDataUri(env, request, key) {
  if (key) {
    const obj = await env.R2.get(key);
    if (obj) {
      const bytes = new Uint8Array(await obj.arrayBuffer());
      if (bytes.length && bytes.length <= 512 * 1024) {
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return `data:${obj.httpMetadata?.contentType || 'image/png'};base64,${btoa(bin)}`;
      }
    }
  }
  return defaultIconUri(env, request);
}

let defaultIconCache = null;
async function defaultIconUri(env, request) {
  if (defaultIconCache) return defaultIconCache;
  try {
    const res = await env.ASSETS.fetch(new URL('/assets/default-icon.png', request.url));
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    defaultIconCache = `data:image/png;base64,${btoa(bin)}`;
    return defaultIconCache;
  } catch { return null; }
}

async function render(env, request, tree) {
  ensureYoga();
  const fontRes = await env.ASSETS.fetch(new URL('/assets/font/Minecraftia-Regular.ttf', request.url));
  const font = await fontRes.arrayBuffer();
  const svg = await satori(tree, {
    width: W, height: H, fonts: [{ name: 'Pixel', data: font, weight: 400, style: 'normal' }],
  });
  await ensureWasm();
  return new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
}

// immutable for a year, and Discord caches on top - only a new key replaces one
const imagePng = (body) => new Response(body, {
  headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable' },
});

export async function handleOg(request, env, ctx, slug, name) {
  const server = await liveServer(env, slug);
  if (!server || !server.build_id || !server.published) return new Response('Not found', { status: 404 });

  const pal = PALETTES[(server.palette | 0) % PALETTES.length];
  // name is drawn on both layouts, so a rename has to land on a fresh key
  const stamp = (server.icon_key || 'nologo').split('/').pop().split('.')[0]
    + '-' + stampOf(server.name);

  const bd = name ? null : worldAge(server.world_born_at);
  const party = !!(bd && bd.is_birthday);

  let key, row = null;
  if (name) {
    row = await findPlayer(env, server.id, name, ctx);
    if (!row) return new Response('Not found', { status: 404 });
    key = `og/${server.id}/${server.build_id}/${stamp}/${row.uuid}.png`;
  } else {
    key = `og/${server.id}/${server.build_id}/${stamp}/_server${party ? `-b${bd.turning}` : ''}.png`;
  }

  const t0 = Date.now();
  const hit = await env.R2.get(key);
  if (hit) {
    trackOgRender(env, slug, true, Date.now() - t0);
    return imagePng(hit.body);
  }

  const logo = await logoDataUri(env, request, server.icon_key);

  let tree;
  if (row) {
    const doc = await readPlayerDoc(env, server.build_id, row);
    if (!doc) return new Response('Not found', { status: 404 });
    tree = playerTemplate({ player: doc, server, pal, logo });
  } else {
    const summaryObj = await env.R2.get(`build/${server.build_id}/server.json`);
    const summary = summaryObj ? await summaryObj.json() : null;
    tree = serverTemplate({ server, summary, pal, logo, birthday: bd });
  }

  const png = await render(env, request, tree);

  ctx.waitUntil(env.R2.put(key, png, { httpMetadata: { contentType: 'image/png' } }));
  trackOgRender(env, slug, false, Date.now() - t0);

  return imagePng(png);
}
