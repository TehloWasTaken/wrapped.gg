import { json, err, now, ulid, randomToken, cookie, readCookie } from '../lib/util.js';

const SESSION_DAYS = 30;
export const SESSION_COOKIE = 'wgg_session';

const originOf = (request, env) => {
  try { return new URL(request.url).origin; }
  catch { return env.SITE_URL; }
};

export function loginUrl(request, env, state) {
  const p = new URLSearchParams({
    client_id: env.DISCORD_CLIENT_ID,
    redirect_uri: `${originOf(request, env)}/auth/callback`,
    response_type: 'code',
    scope: 'identify',
    state,
    prompt: 'consent',
  });
  return `https://discord.com/oauth2/authorize?${p}`;
}

export async function handleLogin(request, env) {
  if (!env.DISCORD_CLIENT_ID || env.DISCORD_CLIENT_ID === 'SET_ME') {
    return err('not_configured',
      'DISCORD_CLIENT_ID is not set in wrangler.toml. Set it and redeploy.', 500);
  }
  if (!env.DISCORD_CLIENT_SECRET) {
    return err('not_configured',
      'DISCORD_CLIENT_SECRET is not set. Run: wrangler secret put DISCORD_CLIENT_SECRET', 500);
  }

  const state = randomToken(16);
  const url = new URL(request.url);
  const next = url.searchParams.get('next') || '/panel';
  await env.KV.put(`oauth:${state}`, next.startsWith('/') ? next : '/panel',
                   { expirationTtl: 600 });
  return new Response(null, { status: 302, headers: { location: loginUrl(request, env, state) } });
}

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return err('bad_request', 'Missing code or state', 400);

  const next = await env.KV.get(`oauth:${state}`);
  if (!next) return err('bad_state', 'Login expired or replayed. Try again.', 400);
  await env.KV.delete(`oauth:${state}`);

  const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.DISCORD_CLIENT_ID,
      client_secret: env.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${originOf(request, env)}/auth/callback`,
    }),
  });
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '');
    return err('discord_token',
      `Discord rejected the login. Check the redirect URI is registered as ` +
      `${originOf(request, env)}/auth/callback`, 502,
      { discord: detail.slice(0, 200) });
  }
  const token = await tokenRes.json();

  const meRes = await fetch('https://discord.com/api/users/@me', {
    headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!meRes.ok) return err('discord_me', 'Could not read your Discord profile', 502);
  const me = await meRes.json();

  const t = now();
  const existing = await env.DB.prepare('SELECT id FROM users WHERE discord_id = ?')
    .bind(me.id).first();

  let userId;
  if (existing) {
    userId = existing.id;
    await env.DB.prepare(
      'UPDATE users SET username = ?, avatar = ?, last_login_at = ? WHERE id = ?')
      .bind(me.username, me.avatar || null, t, userId).run();
  } else {
    userId = ulid();
    await env.DB.prepare(
      'INSERT INTO users (id, discord_id, username, avatar, created_at, last_login_at) VALUES (?,?,?,?,?,?)')
      .bind(userId, me.id, me.username, me.avatar || null, t, t).run();
  }

  const sid = randomToken(32);
  const expires = t + SESSION_DAYS * 86400;
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?,?,?,?)')
    .bind(sid, userId, t, expires).run();

  return new Response(null, {
    status: 302,
    headers: {
      location: next,
      'set-cookie': cookie(SESSION_COOKIE, sid, { maxAge: SESSION_DAYS * 86400 }),
    },
  });
}

export async function handleLogout(request, env) {
  const sid = readCookie(request, SESSION_COOKIE);
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  return new Response(null, {
    status: 302,
    headers: { location: '/', 'set-cookie': cookie(SESSION_COOKIE, '', { maxAge: 0 }) },
  });
}

export async function currentUser(request, env) {
  const sid = readCookie(request, SESSION_COOKIE);
  if (!sid) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.discord_id, u.username, u.avatar, s.expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`).bind(sid).first();
  if (!row) return null;
  if (row.expires_at < now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
    return null;
  }
  return { id: row.id, discord_id: row.discord_id, username: row.username, avatar: row.avatar };
}

export async function requireUser(request, env) {
  const user = await currentUser(request, env);
  if (!user) throw json({ error: 'unauthorized', message: 'Sign in with Discord first' }, 401);
  return user;
}
