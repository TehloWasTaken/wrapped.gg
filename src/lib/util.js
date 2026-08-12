export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });

export const err = (code, message, status = 400, extra = {}) =>
  json({ error: code, message, ...extra }, status);

export const now = () => Math.floor(Date.now() / 1000);

export function ulid() {
  const t = Date.now().toString(36).padStart(9, '0');
  const r = crypto.getRandomValues(new Uint8Array(10));
  return t + [...r].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 16);
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// constant time over the bytes; length leaks, fine for fixed-width hashes
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function randomToken(bytes = 32) {
  const r = crypto.getRandomValues(new Uint8Array(bytes));
  return [...r].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])$/;
export const isSlug = (s) => typeof s === 'string' && SLUG_RE.test(s);

export const SLUG_BASE_RE = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])$/;
export const isSlugBase = (s) => typeof s === 'string' && SLUG_BASE_RE.test(s);

// no 0/1/i/l/o - people read these off Discord and type them back in
const SUFFIX_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
export function slugSuffix(len = 5) {
  const r = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += SUFFIX_ALPHABET[r[i] % SUFFIX_ALPHABET.length];
  return out;
}

export function slugify(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
    .replace(/-+$/g, '');
}

// FNV-1a. Only ever used to fold a mutable value into a cache key.
export function stampOf(s) {
  const str = String(s == null ? '' : s);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h.toString(36);
}

export const escapeHtml = (s) => String(s == null ? '' : s).replace(
  /[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const normName = (s) => String(s || '').trim().toLowerCase();

export function cookie(name, value, { maxAge = 0, secure = true } = {}) {
  const bits = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) bits.push('Secure');
  bits.push(`Max-Age=${maxAge}`);
  return bits.join('; ');
}

export function readCookie(request, name) {
  const raw = request.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function purgeServerObjects(env, serverId) {
  for (const prefix of [`snapshots/${serverId}/`, `og/${serverId}/`, `logo/${serverId}/`]) {
    let cursor;
    do {
      const listed = await env.R2.list({ prefix, cursor, limit: 500 });
      if (listed.objects.length) await env.R2.delete(listed.objects.map(o => o.key));
      cursor = listed.truncated ? listed.cursor : null;
    } while (cursor);
  }
  const builds = await env.DB.prepare('SELECT id FROM builds WHERE server_id = ?')
    .bind(serverId).all();
  for (const b of builds.results || []) {
    await env.R2.delete([`build/${b.id}/players.ndjson`, `build/${b.id}/server.json`,
                         `build/${b.id}/ranks.ndjson`]);
  }
}

// Fixed window, so 2x is reachable across a boundary. KV is eventually
// consistent anyway, so precision here would be pretend.
export async function rateLimit(env, key, limit, windowSec) {
  const bucket = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSec)}`;
  const cur = Number(await env.KV.get(bucket)) || 0;
  if (cur >= limit) return false;
  await env.KV.put(bucket, String(cur + 1), { expirationTtl: windowSec + 60 });
  return true;
}

export const dashless = (u) => String(u || '').replace(/-/g, '').toLowerCase();

// Floodgate uuid is new UUID(0, xuid): top half zeros, bottom half the XUID.
// Test the top half. This used to look for a "0009" prefix and filed every
// newer XUID as Java.
export function isFloodgateUuid(u) {
  const d = dashless(u);
  return d.length === 32 && /^0{16}/.test(d) && /[1-9a-f]/.test(d.slice(16));
}

export const platformOf = (uuid) => (isFloodgateUuid(uuid) ? 'bedrock' : 'java');

// First 8 hex is fine for Java, useless for Bedrock where it's zeros for
// everyone. 2,304 players on one server all came out as 00000000.
export function fallbackName(uuid) {
  const d = dashless(uuid);
  if (!d) return 'Unknown player';
  if (isFloodgateUuid(d)) return `Bedrock-${d.slice(-6)}`;
  return d.slice(0, 8);
}

// knows the old 8-hex form too so legacy rows get re-resolved on read
export const isFallbackName = (name, uuid) => {
  const n = String(name || '').trim();
  if (!n) return true;
  const d = dashless(uuid);
  return n === d.slice(0, 8) || n === fallbackName(d);
};

export function xuidOf(uuid) {
  const d = dashless(uuid);
  if (!isFloodgateUuid(d)) return null;
  try { return BigInt('0x' + d.slice(16)).toString(10); } catch { return null; }
}

export function floodgateUuid(xuid) {
  let hex;
  try { hex = BigInt(xuid).toString(16); } catch { return null; }
  if (hex.length > 16 || BigInt(xuid) <= 0n) return null;
  const d = '0'.repeat(32 - hex.length) + hex;
  return `${d.slice(0, 8)}-${d.slice(8, 12)}-${d.slice(12, 16)}-${d.slice(16, 20)}-${d.slice(20)}`;
}

export const isGamertag = (n) =>
  typeof n === 'string' && /^[A-Za-z0-9][A-Za-z0-9 ]{0,14}$/.test(n) && n.trim().length >= 1;
