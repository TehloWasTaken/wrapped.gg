import { trackHead } from '../lib/metrics.js';
import { isFloodgateUuid, xuidOf } from '../lib/util.js';
import { headFromSkin } from '../lib/skin.js';

const UPSTREAM = 'https://mc-heads.net/avatar';
const GEYSER_SKIN = 'https://api.geysermc.org/v2/skin';
const TEXTURES = 'https://textures.minecraft.net/texture';
const TTL = 'public, max-age=31536000, immutable';
const NO_SKIN_TTL = 6 * 60 * 60;
const MAX_SKIN_BYTES = 200000;

export async function handleHead(request, env, ctx, raw) {
  const uuid = String(raw || '').replace(/\.png$/, '');
  if (!/^[0-9a-fA-F-]{16,48}$/.test(uuid)) return fallback(request, env);

  const key = `head/${uuid}.png`;
  const hit = await env.R2.get(key);
  if (hit) {
    trackHead(env, true);
    return new Response(hit.body, { headers: { 'content-type': 'image/png', 'cache-control': TTL } });
  }

  const bytes = isFloodgateUuid(uuid)
    ? await bedrockHead(env, ctx, uuid)
    : await javaHead(uuid);
  if (!bytes) return fallback(request, env);

  ctx.waitUntil(env.R2.put(key, bytes, { httpMetadata: { contentType: 'image/png' } }));
  trackHead(env, false);
  return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': TTL } });
}

async function javaHead(uuid) {
  let upstream;
  try {
    upstream = await fetch(`${UPSTREAM}/${uuid}/128`, {
      cf: { cacheTtl: 86400, cacheEverything: true },
    });
  } catch { return null; }
  if (!upstream || !upstream.ok) return null;
  const bytes = await upstream.arrayBuffer();
  return bytes.byteLength < 128 ? null : new Uint8Array(bytes);
}

async function bedrockHead(env, ctx, uuid) {
  const xuid = xuidOf(uuid);
  if (!xuid) return null;

  const marker = `bedskin:${uuid.toLowerCase()}`;
  try { if (await env.KV.get(marker) === '!') return null; } catch {}

  const forget = () => {
    const put = env.KV.put(marker, '!', { expirationTtl: NO_SKIN_TTL }).catch(() => {});
    if (ctx) ctx.waitUntil(put);
  };

  let texture;
  try {
    const res = await fetch(`${GEYSER_SKIN}/${xuid}`, {
      headers: { accept: 'application/json' },
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null);
    texture = body && body.texture_id;
  } catch { return null; }

  if (!texture || !/^[0-9a-f]{32,128}$/i.test(texture)) { forget(); return null; }

  let skin;
  try {
    const res = await fetch(`${TEXTURES}/${texture}`, {
      cf: { cacheTtl: 604800, cacheEverything: true },
    });
    if (!res.ok) { if (res.status === 404) forget(); return null; }
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_SKIN_BYTES) return null;
    skin = new Uint8Array(buf);
  } catch { return null; }

  const head = await headFromSkin(skin);
  if (!head) forget();
  return head;
}

async function fallback(request, env) {
  const res = await env.ASSETS.fetch(new URL('/assets/head-fallback.png', request.url));
  return new Response(res.body, {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' },
  });
}
