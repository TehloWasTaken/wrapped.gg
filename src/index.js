import { json, err, isSlug, escapeHtml, readCookie } from './lib/util.js';
import {
  handleLogin, handleCallback, handleLogout, currentUser, SESSION_COOKIE,
} from './auth/discord.js';
import { handleIngest, handleSnapshotStatus } from './api/ingest.js';
import {
  handleMe, handleCreateServer, handleUpdateServer, handleDeleteServer,
  handleCreateKey, handleRevokeKey, handleListSnapshots,
  handleUploadLogo, handleDeleteLogo, handleServeLogo, handleSessionKey,
  handleKeyLogo, handleSearchPlayers, handleListBlocked, handleBlockPlayer,
  handleUnblockPlayer,
} from './api/servers.js';
import {
  handlePlayerData, handleServerData, liveServer, findPlayer, readPlayerDoc, metaTags,
  embedTags, playersServed, servedLine, handleSitemap,
} from './api/public.js';
import { routeHost, handleClaim } from './api/partners.js';
import { handleBuild } from './build/consumer.js';
import { handleHead } from './api/heads.js';
import { handleMetrics } from './api/metrics.js';
import { handleAnalytics } from './api/analytics.js';
import { trackPageView } from './lib/metrics.js';
import { worldAge } from './lib/birthday.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const seg = path.split('/').filter(Boolean);
    const method = request.method;

    try {
      return secure(await route(request, env, ctx, { path, seg, method }));
    } catch (e) {
      if (e instanceof Response) return secure(e);
      console.error('unhandled', e && e.stack);
      return secure(err('internal', 'Something broke on our side', 500));
    }
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      try {
        await handleBuild(message, env);
        message.ack();
      } catch (e) {
        console.error('build failed', e && e.message);
        message.retry();
      }
    }
  },
};

const HSTS = 'max-age=31536000';

// Only wraps Worker responses. Static assets never reach this, but any hit
// on / pins the host for that visitor anyway.
function secure(res) {
  if (!(res instanceof Response) || res.status === 304) return res;
  if (res.headers.has('strict-transport-security')) return res;
  const out = new Response(res.body, res);
  out.headers.set('strict-transport-security', HSTS);
  return out;
}

async function route(request, env, ctx, { path, seg, method }) {
  if (path === '/metrics') return handleMetrics(request, env);

  if (path === '/auth/login') return handleLogin(request, env);
  if (path === '/auth/callback') return handleCallback(request, env);
  if (path === '/auth/logout' && method === 'POST') return handleLogout(request, env);

  if (seg[0] === 'v1') {
    if (seg[1] === 'host') return routeHost(request, env, { seg, method });
    if (path === '/v1/me') return handleMe(request, env);

    if (path === '/v1/servers' && method === 'POST') return handleCreateServer(request, env);
    if (seg[1] === 'servers' && seg[2]) {
      const id = seg[2];
      if (seg.length === 3 && method === 'PATCH') return handleUpdateServer(request, env, id);
      if (seg.length === 3 && method === 'DELETE') return handleDeleteServer(request, env, id);
      if (seg[3] === 'keys' && seg.length === 4 && method === 'POST') return handleCreateKey(request, env, id);
      if (seg[3] === 'keys' && seg[4] && method === 'DELETE') return handleRevokeKey(request, env, id, seg[4]);
      if (seg[3] === 'snapshots' && method === 'GET') return handleListSnapshots(request, env, id);
      if (seg[3] === 'players' && seg.length === 4 && method === 'GET') {
        return handleSearchPlayers(request, env, id);
      }
      if (seg[3] === 'blocked') {
        if (seg.length === 4 && method === 'GET') return handleListBlocked(request, env, id);
        if (seg.length === 4 && method === 'POST') return handleBlockPlayer(request, env, id);
        if (seg[4] && method === 'DELETE') return handleUnblockPlayer(request, env, id, seg[4]);
      }
      if (seg[3] === 'analytics' && method === 'GET') return handleAnalytics(request, env, id);
      if (seg[3] === 'session-key' && seg.length === 4 && method === 'POST') {
        return handleSessionKey(request, env, id);
      }
      if (seg[3] === 'logo' && seg.length === 4) {
        if (method === 'POST') return handleUploadLogo(request, env, id);
        if (method === 'DELETE') return handleDeleteLogo(request, env, id);
      }
    }

    if (path === '/v1/snapshots' && method === 'POST') return handleIngest(request, env, ctx);
    if (path === '/v1/logo' && method === 'POST') return handleKeyLogo(request, env);
    if (seg[1] === 'snapshots' && seg[2] && method === 'GET') {
      return handleSnapshotStatus(request, env, seg[2]);
    }

    if (seg[1] === 's' && seg[2]) return handleServerData(request, env, seg[2], ctx);
    if (seg[1] === 'p' && seg[2] && seg[3]) {
      return handlePlayerData(request, env, seg[2], decodeURIComponent(seg[3]), ctx);
    }
    return err('not_found', 'No such endpoint', 404);
  }

  if (seg[0] === 'og' && seg[1]) {
    const { handleOg } = await import('./og/card.js');
    const slug = seg[1].replace(/\.png$/, '');
    const name = seg[2] ? decodeURIComponent(seg[2].replace(/\.png$/, '')) : null;
    return handleOg(request, env, ctx, slug, name);
  }
  if (seg[0] === 'head' && seg[1]) return handleHead(request, env, ctx, seg[1]);
  if (seg[0] === 'logo' && seg[1] && seg.length === 2) {
    return handleServeLogo(env, seg[1].replace(/\.(png|jpe?g|webp)$/i, ''));
  }

  if (seg[0] === 'assets' || STATIC_FILES.has(path)) return env.ASSETS.fetch(request);

  if (path === '/u') {
    const res = await env.ASSETS.fetch(new URL('/assets/upload.sh', request.url));
    return new Response(res.body, {
      status: res.status,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'public, max-age=600',
      },
    });
  }

  if (path === '/embed.js') return embedScript(request, env);
  if (seg[0] === 'embed') {
    if (seg.length === 1) {
      return new Response(null, { status: 302, headers: { location: '/docs#embed' } });
    }
    if (seg.length <= 3 && isSlug(seg[1])) {
      return tenantPage(request, env, ctx, seg[1],
                        seg[2] ? decodeURIComponent(seg[2]) : null, true);
    }
    return new Response('Not found', { status: 404 });
  }

  if (path === '/sitemap.xml') return handleSitemap(request, env);
  if (path === '/' || path === '/index.html') return landing(request, env);
  if (path === '/panel' || path === '/panel.html') return shell(env, request, 'panel.html', true);
  if (path === '/upload' || path === '/upload.html') return shell(env, request, 'upload.html');
  if (path === '/docs' || path === '/docs.html' || path === '/help' || path === '/setup') {
    return shell(env, request, 'docs.html');
  }
  if (path === '/hosts' || path === '/hosts.html' || path === '/host'
      || path === '/hosting' || path === '/partners') {
    return shell(env, request, 'hosts.html');
  }

  if (seg[0] === 'claim' && seg[1] && seg.length === 2) {
    return handleClaim(request, env, decodeURIComponent(seg[1]));
  }

  if (seg.length >= 1 && seg.length <= 2 && isSlug(seg[0])) {
    return tenantPage(request, env, ctx, seg[0], seg[1] ? decodeURIComponent(seg[1]) : null);
  }

  return new Response('Not found', { status: 404 });
}

// Root-level files the slug route would otherwise swallow. Anything
// server-rendered also needs listing in assets.run_worker_first.
const STATIC_FILES = new Set([
  '/favicon.ico', '/favicon.png', '/favicon-16.png', '/apple-touch-icon.png',
  '/icon-192.png', '/icon-512.png', '/site.webmanifest',
  '/robots.txt', '/og.png', '/llms.txt',
  '/icon-48.png', '/icon-96.png',
]);

async function landing(request, env) {
  const res = await env.ASSETS.fetch(new URL('/index.html', request.url));
  let html = await res.text();
  html = html.replace('<!--SERVED-->', servedLine(await playersServed(env)));
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300, s-maxage=900',
    },
  });
}

async function shell(env, request, file, sessionAware = false) {
  const res = await env.ASSETS.fetch(new URL('/' + file, request.url));
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'x-frame-options': 'DENY',
  };
  if (!sessionAware) return new Response(res.body, { status: res.status, headers });

  headers['cache-control'] = 'private, no-store';
  const html = readCookie(request, SESSION_COOKIE)
    ? (await res.text()).replace('<body class="app">', '<body class="app signed-in">')
    : res.body;
  return new Response(html, { status: res.status, headers });
}

async function embedScript(request, env) {
  const res = await env.ASSETS.fetch(new URL('/assets/embed.js', request.url));
  return new Response(res.body, {
    status: res.status,
    headers: {
      'content-type': 'text/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
      'access-control-allow-origin': '*',
    },
  });
}

const FRAMEABLE = 'frame-ancestors *';

async function tenantPage(request, env, ctx, slug, playerName, embed = false) {
  const server = await liveServer(env, slug);
  if (!server || !server.published || !server.build_id) {
    return new Response(embed ? embedMissingHtml(slug) : notFoundHtml(slug), {
      status: 404,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        ...(embed ? { 'content-security-policy': FRAMEABLE } : {}),
      },
    });
  }

  let summaryLine = server.description || null;
  if (playerName) {
    const row = await findPlayer(env, server.id, playerName, ctx);
    if (row) {
      const doc = await readPlayerDoc(env, server.build_id, row);
      if (doc) {
        playerName = doc.name || playerName;
        const bits = [];
        if (doc.playtime_hours > 0) bits.push(`${Math.round(doc.playtime_hours).toLocaleString()} hours played`);
        if (doc.blocks_mined > 0) bits.push(`${doc.blocks_mined.toLocaleString()} blocks mined`);
        if (doc.signature_award) bits.push(`#${doc.signature_award.rank} at ${doc.signature_award.title}`);
        summaryLine = bits.join(' · ') || summaryLine;
      }
    }
  }

  trackPageView(env, slug, playerName ? 'player' : 'server', embed ? 'embed' : 'site');

  const birthday = worldAge(server.world_born_at);

  const res = await env.ASSETS.fetch(new URL('/wrapped.html', request.url));
  let html = await res.text();
  html = html.replace('<!--META-->', embed
    ? embedTags({ serverName: server.name, palette: server.palette })
    : metaTags({
        siteUrl: env.SITE_URL, slug, playerName, serverName: server.name, summaryLine,
        palette: server.palette, birthday,
      }));
  // Names are user input going into a <script>. JSON escaping alone won't
  // stop a name containing a closing script tag, hence the angle brackets.
  html = html.replace('<!--BOOT-->',
    `<script>window.__WGG__=${JSON.stringify({
      slug, player: playerName, embed,
      server: {
        name: server.name, palette: server.palette,
        logo: server.icon_key ? `/logo/${server.slug}.png` : null,
        birthday,
      },
    }).replace(/</g, '\\u003c')};` +
    `if(window.__WGG__.embed)document.documentElement.classList.add('embed')</script>`);

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=60, s-maxage=600',
      ...(embed ? { 'content-security-policy': FRAMEABLE, 'x-robots-tag': 'noindex' } : {}),
    },
  });
}

const notFoundHtml = (slug) => `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nothing here yet - wrapped.gg</title>
<meta name="robots" content="noindex">
<link rel="icon" href="/favicon.ico" sizes="any">
<style>
@font-face{font-family:'Pixel';src:url('/assets/font/Minecraftia-Regular.ttf') format('truetype');font-display:swap}
body{background:#14141a;color:#eeeef4;font:16px/1.7 ui-sans-serif,system-ui,sans-serif;
  display:grid;place-items:center;min-height:100vh;margin:0;padding:24px;text-align:center}
h1{font-family:'Pixel',monospace;-webkit-font-smoothing:none;font-weight:400;font-size:26px;
  margin:0 0 14px;text-shadow:2px 2px 0 rgba(0,0,0,.55)}
p{color:#adadba;margin:0 0 12px}
code{background:#101015;border:1px solid #363642;padding:1px 6px;font-size:14px}
a.b{display:inline-block;margin-top:18px;padding:13px 22px;background:#3ecf72;color:#05240f;
  font-family:'Pixel',monospace;-webkit-font-smoothing:none;text-decoration:none;
  border:3px solid;border-color:#5ded8f #1c8b48 #1c8b48 #5ded8f}
</style>
<div><h1>Nothing here yet</h1>
<p>There is no published Wrapped at <code>${escapeHtml(slug)}</code>.</p>
<p>Links carry a short random code on the end, so it is worth checking you
copied the whole thing.</p>
<a class="b" href="/">Make one for your server</a></div></html>`;

const embedMissingHtml = (slug) => `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nothing here yet</title>
<meta name="robots" content="noindex">
<style>
@font-face{font-family:'Pixel';src:url('/assets/font/Minecraftia-Regular.ttf') format('truetype');font-display:swap}
html,body{height:100%}
body{background:#14141a;color:#eeeef4;font:15px/1.7 ui-sans-serif,system-ui,sans-serif;
  display:grid;place-items:center;margin:0;padding:22px;text-align:center}
h1{font-family:'Pixel',monospace;-webkit-font-smoothing:none;font-weight:400;font-size:19px;
  margin:0 0 10px;text-shadow:2px 2px 0 rgba(0,0,0,.55)}
p{color:#adadba;margin:0}
code{background:#101015;border:1px solid #363642;padding:1px 6px;font-size:13px}
a{color:#5ded8f}
</style>
<div><h1>Nothing here yet</h1>
<p>No Wrapped is published at <code>${escapeHtml(slug)}</code>.</p>
<p style="margin-top:10px;font-size:13px;color:#7c7c8a">Site owner: check the slug on your
<a href="/panel" target="_blank" rel="noopener">wrapped.gg panel</a>, and that the page is published.</p></div></html>`;
