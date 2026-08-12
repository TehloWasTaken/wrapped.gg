const nf = (n) => Number(n || 0).toLocaleString('en-US');
const CARD_W = 1080, CARD_H = 1350;
const PAD = 84, INNER = CARD_W - PAD * 2, MID = CARD_W / 2;
const GOLD = '#ffc93c';

const PALETTES = [
  ['#7a3a17','#2c1207','#0b0503','#ffb765'],
  ['#1f4467','#0e1c2e','#04070d','#8fd0ff'],
  ['#4b2a70','#1e102c','#07040a','#d9a6ff'],
  ['#1a5340','#0b2219','#030906','#5ded8f'],
  ['#6b2233','#2c0e17','#090306','#ff9fae'],
  ['#6b4c11','#261b07','#080602','#ffc93c'],
];
const BGS = ['mc_mounts', 'mc_copper', 'mc_chaos', 'mc_tiny'].map(n => `/assets/bg/${n}.jpg`);
const safeId = (id) => (/^[a-z0-9_]{1,64}$/.test(String(id)) ? id : null);
const ICO = (id) => safeId(id) ? `/assets/icons/${id}.png` : null;

function seedOf(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}
const pickSeeded = (arr, seed, salt) => arr[(seed + salt) % arr.length];

function persona(p) {
  const R = p.rank || {};
  const cand = [
    ['miner', R.mined], ['fighter', R.killed], ['explorer', R.distance],
    ['crafter', R.crafted], ['veteran', R.playtime],
  ].filter(c => c[1] && c[1].x_avg).sort((a, b) => b[1].x_avg - a[1].x_avg);

  let key = cand.length ? cand[0][0] : 'newcomer';
  if (p.playtime_hours < 1) key = 'newcomer';
  else if (p.deaths === 0 && p.playtime_hours > 5) key = 'untouchable';
  else if (R.deaths && R.deaths.x_avg > 3) key = 'unlucky';

  const seed = seedOf(p.uuid || p.name || 'x');
  const TITLES = {
    miner: ['The Tunnel Rat','The Deep Delver','Stone Eater','The Excavator','Bedrock Botherer','Pickaxe Enjoyer'],
    fighter: ['The Mob Grinder','Sword Hand','The Reaper','Spawn Camper','The Exterminator','Local Menace'],
    explorer: ['The Wanderer','Chunk Loader','The Cartographer','Horizon Chaser','The Nomad','Map Filler'],
    crafter: ['The Workbench Wizard','Master of Recipes','The Fabricator','Bulk Producer','Stick Magnate'],
    veteran: ['The Lifer','Server Furniture','The Old Guard','Always Online','The Regular'],
    untouchable: ['The Untouchable','Flawless','Never Died Once','Risk Averse','Still Standing'],
    unlucky: ['The Respawner','Gravity’s Favourite','Frequent Flyer','Bed Dependent','Repeat Offender'],
    newcomer: ['The Fresh Spawn','Just Getting Started','New Blood','Day One Energy'],
  };
  const QUIPS = {
    miner: [
      () => 'Has personally lowered the sea level of at least one biome.',
      () => `${nf(p.blocks_mined)} blocks gone. Somewhere out there is a very large hole.`,
      () => 'Treats bedrock as a suggestion.',
      () => `Mined ${nf(Math.round(p.blocks_mined / 3456))} double chests worth. Storage remains a problem.`,
    ],
    fighter: [
      () => 'The mobs have started filing complaints.',
      () => `${nf(p.mobs_killed)} mobs later, still not bored.`,
      () => 'Has turned violence into a renewable resource.',
      () => 'Every hostile mob on this server knows the name.',
    ],
    explorer: [
      () => 'Owns more of the map than the map does.',
      () => `${nf(Math.round(p.distance?.total_km || 0))} km travelled. Never met a horizon they did not walk into.`,
      () => 'Elytra: not a tool, a personality.',
      () => 'Spawn is a rumour to this one.',
    ],
    crafter: [
      () => 'The crafting table files them as a dependent.',
      () => `${nf(p.items_crafted)} items crafted. Most of them sticks, statistically.`,
      () => 'Has never once had enough chests.',
    ],
    veteran: [
      () => 'Load-bearing member of this server.',
      () => `${nf(Math.round(p.playtime_hours))} hours. At some point this stopped being a game and became a commute.`,
      () => 'If the server is up, they are on it.',
      () => 'Knows where everything is. Built half of it.',
    ],
    untouchable: [
      () => 'Has never died. Not once. Suspicious, frankly.',
      () => 'Fall damage is something that happens to other people.',
      () => `${nf(Math.round(p.playtime_hours))} hours without a single death. Cowardice or genius.`,
    ],
    unlucky: [
      () => `${nf(p.deaths)} deaths. Gravity remains undefeated.`,
      () => 'Has funded the respawn industry single-handedly.',
      () => 'Their XP is scattered across three dimensions.',
    ],
    newcomer: [
      () => 'Just getting started. The best part is still ahead.',
      () => 'New here, and already on the board.',
      () => 'Every veteran on this list started exactly here.',
    ],
  };
  return {
    seed,
    title: pickSeeded(TITLES[key] || TITLES.newcomer, seed, 0),
    quip: (pickSeeded(QUIPS[key] || QUIPS.newcomer, seed, 7))(),
  };
}

function serverPersona(s, server) {
  const seed = seedOf(String(server?.slug || server?.name || 'server'));
  const has = (n) => typeof n === 'number' && n > 0;
  const years = (s.playtime_hours || 0) / 8760;

  const QUIPS = [
    has(s.players_active) &&
      `${nf(s.players_active)} people, one world, and nobody agreed on where the storage room goes.`,
    has(s.playtime_hours) && (years >= 1
      ? `${years.toFixed(1)} years of playtime. Nobody left their chair for any of it.`
      : `${nf(Math.round(s.playtime_hours))} hours of playtime, and every one of them voluntary.`),
    has(s.blocks_mined) && `${nf(s.blocks_mined)} blocks gone. The terrain will not be recovering.`,
    has(s.deaths) && `${nf(s.deaths)} deaths between everyone. Respawning is free; the walk back is not.`,
    'A year of shared holes, borrowed tools and unexplained redstone.',
  ].filter(Boolean);
  return { seed, quip: pickSeeded(QUIPS, seed, 3) };
}

const cardAwards = (p, n) => (p.awards || [])
  .filter(a => a && a.title && a.of >= 5 && a.rank <= Math.max(10, a.of * 0.5)).slice(0, n);

function cardHeadline(p, n) {
  const R = p.rank || {};
  return [
    p.playtime_hours > 0 && ['play', nf(Math.round(p.playtime_hours)), 'HOURS PLAYED', R.playtime],
    p.blocks_mined > 0 && ['mine_stone', nf(p.blocks_mined), 'BLOCKS MINED', R.mined],
    p.mobs_killed > 0 && ['kill_any', nf(p.mobs_killed), 'MOB KILLS', R.killed],
    p.distance?.total_km > 0 && ['walk', nf(Math.round(p.distance.total_km)) + ' km', 'TRAVELLED', R.distance],
  ].filter(Boolean).slice(0, n || 2);
}

const serverHeadline = (s, n) => [
  s.playtime_hours > 0 && ['play', nf(Math.round(s.playtime_hours)), 'HOURS PLAYED'],
  s.blocks_mined > 0 && ['mine_stone', nf(s.blocks_mined), 'BLOCKS MINED'],
  s.mobs_killed > 0 && ['kill_any', nf(s.mobs_killed), 'MOBS DEFEATED'],
  s.distance_km > 0 && ['walk', nf(Math.round(s.distance_km)) + ' km', 'TRAVELLED'],
  s.deaths > 0 && ['death', nf(s.deaths), 'DEATHS'],
  s.items_crafted > 0 && ['craft_tools', nf(s.items_crafted), 'ITEMS CRAFTED'],
].filter(Boolean).slice(0, n);

const BOARDS = [
  ['playtime', 'WHO PUT THE HOURS IN', 'h'],
  ['mined', 'WHO MOVED THE MOST STONE', ''],
  ['killed', 'WHO FOUGHT THE MOST', ''],
  ['distance', 'WHO WENT THE FURTHEST', 'km'],
  ['crafted', 'WHO CRAFTED THE MOST', ''],
];
function serverPodium(s) {
  for (const [key, label, unit] of BOARDS) {
    const rows = s.leaderboards && s.leaderboards[key];
    if (rows && rows.length) return { rows: rows.slice(0, 3), label, unit };
  }
  return null;
}

const loadImg = (src) => new Promise(res => {
  if (!src) return res(null);
  const im = new Image();
  im.crossOrigin = 'anonymous';
  im.onload = () => res(im);
  im.onerror = () => res(null);
  im.src = src;
});

function surface(pal, bg) {
  const cv = document.createElement('canvas');
  cv.width = CARD_W; cv.height = CARD_H;
  const c = cv.getContext('2d');

  c.fillStyle = pal[2]; c.fillRect(0, 0, CARD_W, CARD_H);
  if (bg) {
    const r = Math.max(CARD_W / bg.width, CARD_H / bg.height);
    c.drawImage(bg, (CARD_W - bg.width * r) / 2, (CARD_H - bg.height * r) / 2, bg.width * r, bg.height * r);
  }
  const g = c.createLinearGradient(0, 0, CARD_W * 0.4, CARD_H);
  g.addColorStop(0, pal[0] + 'c4'); g.addColorStop(0.6, pal[1] + 'ec'); g.addColorStop(1, pal[2] + 'f7');
  c.fillStyle = g; c.fillRect(0, 0, CARD_W, CARD_H);

  const t = document.createElement('canvas'); t.width = t.height = 4;
  const tc = t.getContext('2d');
  tc.fillStyle = 'rgba(255,255,255,0.05)'; tc.fillRect(0, 0, 1, 1);
  tc.fillStyle = 'rgba(0,0,0,0.2)'; tc.fillRect(2, 2, 1, 1);
  c.fillStyle = c.createPattern(t, 'repeat'); c.fillRect(0, 0, CARD_W, CARD_H);

  const v = c.createRadialGradient(CARD_W / 2, CARD_H * 0.42, CARD_W * 0.2, CARD_W / 2, CARD_H * 0.5, CARD_H * 0.8);
  v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.76)');
  c.fillStyle = v; c.fillRect(0, 0, CARD_W, CARD_H);

  const F = (px) => `${px}px Pixel, monospace`;
  c.imageSmoothingEnabled = false;

  const ink = (text, size) => {
    c.font = F(size);
    const m = c.measureText(text);
    const a = m.actualBoundingBoxAscent, d = m.actualBoundingBoxDescent;
    if (typeof a !== 'number' || typeof d !== 'number') return { asc: size * 0.7, desc: 0, h: size * 0.7 };
    return { asc: a, desc: d, h: a + d };
  };
  const txt = (text, x, y, size, color, align, shadow) => {
    c.font = F(size); c.textAlign = align || 'center'; c.textBaseline = 'alphabetic';
    const k = ink(text, size);
    const base = y + (k.asc - k.desc) / 2;
    if (shadow !== false) { c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillText(text, x + 3, base + 3); }
    c.fillStyle = color; c.fillText(text, x, base);
  };
  const clamp = (text, max, size) => {
    c.font = F(size);
    if (c.measureText(text).width <= max) return text;
    let s = text;
    while (s.length > 4 && c.measureText(s + '…').width > max) s = s.slice(0, -1);
    return s + '…';
  };
  const fitted = (text, max, start, min) => {
    let s = start; c.font = F(s);
    while (c.measureText(text).width > max && s > min) { s -= 2; c.font = F(s); }
    return s;
  };
  const stack = (x, cy, big, small, bs, ss, bc, sc, align) => {
    const GAP = 10;
    const a = ink(big, bs).h, b = small ? ink(small, ss).h : 0;
    const top = cy - (a + (small ? GAP + b : 0)) / 2;
    txt(big, x, top + a / 2, bs, bc, align);
    if (small) txt(small, x, top + a + GAP + b / 2, ss, sc, align, false);
  };
  const panel = (x, y, w, h, fill, stroke) => {
    c.fillStyle = fill || 'rgba(0,0,0,0.3)'; c.fillRect(x, y, w, h);
    c.strokeStyle = stroke || 'rgba(255,255,255,0.07)'; c.lineWidth = 2; c.strokeRect(x, y, w, h);
  };

  return { cv, c, F, ink, txt, clamp, fitted, stack, panel };
}

function drawTiles(g, items, icons, y, ACC) {
  const cols = 2, GAP = 26, TH = 128, tw = (INNER - GAP) / cols;
  items.forEach((h, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = PAD + col * (tw + GAP), ty = y + row * (TH + GAP);
    g.panel(x, ty, tw, TH, 'rgba(0,0,0,0.32)', 'rgba(255,255,255,0.08)');
    const cy = ty + TH / 2;
    if (icons[i]) g.c.drawImage(icons[i], x + 26, cy - 26, 52, 52);
    g.stack(x + 96, cy, String(h[1]), h[2], g.fitted(String(h[1]), tw - 120, 42, 26), 19,
            ACC, 'rgba(255,255,255,0.55)', 'left');
  });
  return y + Math.ceil(items.length / cols) * (TH + GAP) + 30;
}

function drawQuip(g, quip, y) {
  const QS = 26, LH = 40;
  g.c.font = g.F(QS);
  const lines = [];
  let line = '';
  for (const w of quip.split(' ')) {
    const cand = line ? line + ' ' + w : w;
    if (g.c.measureText(cand).width > INNER - 72 && line) { lines.push(line); line = w; }
    else line = cand;
  }
  if (line) lines.push(line);

  const boxH = lines.length * LH + 46;
  const spTop = y + 6, spBot = CARD_H - 150 - boxH;
  const boxY = spBot > spTop + 60 ? spTop + (spBot - spTop) / 2 : Math.min(spTop, spBot);
  g.c.fillStyle = 'rgba(0,0,0,0.4)'; g.c.fillRect(PAD, boxY, INNER, boxH);
  g.c.strokeStyle = 'rgba(255,255,255,0.09)'; g.c.lineWidth = 2; g.c.strokeRect(PAD, boxY, INNER, boxH);
  lines.forEach((l, i) => g.txt(l, MID, boxY + 23 + LH / 2 + i * LH, QS, 'rgba(255,255,255,0.86)', 'center', false));
}

function drawFooter(g, server, ACC) {
  g.c.fillStyle = 'rgba(255,255,255,0.12)';
  g.c.fillRect(PAD + 60, CARD_H - 116, INNER - 120, 2);
  g.txt(`wrapped.gg/${server?.slug || ''}`, MID, CARD_H - 80, 24, 'rgba(255,255,255,0.46)');
  g.txt('Make your own server’s Wrapped free at wrapped.gg', MID, CARD_H - 42, 20, ACC, 'center', false);
}

const done = (cv, pi) => { cv.dataset.pal = String(pi); return cv; };

function drawPortrait(g, img, size, y) {
  const x = (CARD_W - size) / 2;
  g.c.fillStyle = 'rgba(0,0,0,0.4)'; g.c.fillRect(x - 7, y - 7, size + 14, size + 14);
  if (img) g.c.drawImage(img, x, y, size, size);
  g.c.strokeStyle = 'rgba(255,255,255,0.24)'; g.c.lineWidth = 4;
  g.c.strokeRect(x - 7, y - 7, size + 14, size + 14);
}

export async function renderCard(p, server, palIdx) {
  try {
    await document.fonts.load('400 60px Pixel');
    await document.fonts.ready;
  } catch {}

  const per = persona(p);
  const pi = (palIdx == null ? per.seed : palIdx) % PALETTES.length;
  const pal = PALETTES[pi];
  const ACC = pal[3];
  const awards = cardAwards(p, 3);
  const heads = cardHeadline(p, awards.length ? 2 : 4);

  const [bg, head, logo, ...icons] = await Promise.all([
    loadImg(BGS[pi % BGS.length]),
    loadImg(`/head/${encodeURIComponent(p.uuid)}.png`),
    loadImg(server?.logo || '/assets/default-icon.png'),
    ...awards.map(a => loadImg(ICO(a.id))),
    ...heads.map(h => loadImg(ICO(h[0]))),
  ]);
  const aIcons = icons.slice(0, awards.length), hIcons = icons.slice(awards.length);

  const g = surface(pal, bg);
  const { c, F, txt, clamp, fitted, stack } = g;

  const svName = String(server?.name || 'wrapped.gg').toUpperCase();
  txt(`${clamp(svName, INNER - 200, 24)}  ·  WRAPPED`, MID, 62, 24, 'rgba(255,255,255,0.45)');
  if (logo) c.drawImage(logo, PAD, 34, 56, 56);

  drawPortrait(g, head, 168, 108);

  const name = p.name || 'Player';
  txt(name, MID, 342, fitted(name, INNER, 62, 34), '#ffffff');
  txt(per.title.toUpperCase(), MID, 400, fitted(per.title.toUpperCase(), INNER, 28, 20), ACC);

  c.fillStyle = 'rgba(255,255,255,0.14)'; c.fillRect(PAD + 120, 442, INNER - 240, 2);

  let y = 480;
  if (heads.length) y = drawTiles(g, heads, hIcons, y, ACC);

  if (awards.length) {
    txt('WHERE THEY RANK HIGHEST', MID, y + 8, 22, 'rgba(255,255,255,0.45)', 'center', false);
    y += 48;
    const ROW = 116, RGAP = 18;
    awards.forEach((a, i) => {
      const ry = y + i * (ROW + RGAP);
      g.panel(PAD, ry, INNER, ROW);
      const cy = ry + ROW / 2;
      if (aIcons[i]) c.drawImage(aIcons[i], PAD + 26, cy - 28, 56, 56);

      const valStr = (a.unit === 'cm') ? (a.value / 100000).toFixed(1) + ' km'
                   : (a.unit === 'ticks') ? (a.value / 20 / 3600).toFixed(1) + ' h' : nf(a.value);
      const rankStr = `#${a.rank} of ${nf(a.of)}`;
      c.font = F(26); const wVal = c.measureText(valStr).width;
      c.font = F(18); const wRank = c.measureText(rankStr).width;
      const rankW = Math.max(wVal, wRank) + 34;
      stack(CARD_W - PAD - 26, cy, valStr, rankStr, 26, 18,
            ACC, a.rank <= 3 ? GOLD : 'rgba(255,255,255,0.45)', 'right');

      const tx = PAD + 106, tmax = INNER - 106 - rankW;
      stack(tx, cy, clamp(a.title, tmax, 30), a.desc ? clamp(a.desc, tmax, 20) : '', 30, 20,
            '#ffffff', 'rgba(255,255,255,0.55)', 'left');
    });
    y += awards.length * (ROW + RGAP) + 14;
  }

  drawQuip(g, per.quip, y);
  drawFooter(g, server, ACC);
  return done(g.cv, pi);
}

export async function renderServerCard(s, server, palIdx) {
  try {
    await document.fonts.load('400 60px Pixel');
    await document.fonts.ready;
  } catch {}

  const per = serverPersona(s, server);
  const fallback = palIdx == null && server && server.palette != null
    ? Number(server.palette) | 0 : per.seed;
  const pi = ((palIdx == null ? fallback : palIdx) % PALETTES.length + PALETTES.length) % PALETTES.length;
  const pal = PALETTES[pi];
  const ACC = pal[3];

  const board = serverPodium(s);
  const tiles = serverHeadline(s, 4);

  const [bg, logo, ...rest] = await Promise.all([
    loadImg(BGS[pi % BGS.length]),
    loadImg(server?.logo || '/assets/default-icon.png'),
    ...tiles.map(t => loadImg(ICO(t[0]))),
    ...(board ? board.rows.map(r => loadImg(`/head/${encodeURIComponent(r.uuid)}.png`)) : []),
  ]);
  const tIcons = rest.slice(0, tiles.length), pHeads = rest.slice(tiles.length);

  const g = surface(pal, bg);
  const { c, txt, clamp, fitted } = g;

  txt('A YEAR IN REVIEW', MID, 62, 24, 'rgba(255,255,255,0.45)');

  drawPortrait(g, logo, 168, 108);

  const name = String(server?.name || 'This server');
  txt(name, MID, 342, fitted(name, INNER, 62, 34), '#ffffff');
  const sub = s.players_active > 0
    ? `${nf(s.players_active)} PLAYERS · ONE YEAR`
    : 'ONE YEAR, ALL OF IT';
  txt(sub, MID, 400, fitted(sub, INNER, 28, 20), ACC);

  c.fillStyle = 'rgba(255,255,255,0.14)'; c.fillRect(PAD + 120, 442, INNER - 240, 2);

  let y = 480;
  if (tiles.length) y = drawTiles(g, tiles, tIcons, y, ACC);

  if (board) {
    txt(board.label, MID, y + 8, 22, 'rgba(255,255,255,0.45)', 'center', false);
    y += 48;
    const GAP = 22, PW = (INNER - GAP * 2) / 3, BH = 178, HS = 84;
    const x0 = PAD + (INNER - (board.rows.length * PW + (board.rows.length - 1) * GAP)) / 2;
    board.rows.forEach((r, i) => {
      const x = x0 + i * (PW + GAP), cx = x + PW / 2;
      g.panel(x, y, PW, BH);
      txt(`#${r.rank}`, x + 14, y + 22, 18, i === 0 ? GOLD : 'rgba(255,255,255,0.4)', 'left', false);
      if (pHeads[i]) c.drawImage(pHeads[i], cx - HS / 2, y + 18, HS, HS);
      const who = String(r.name || 'Unknown');
      txt(clamp(who, PW - 28, 24), cx, y + 126, 24, '#ffffff');
      txt(nf(r.value) + (board.unit ? ' ' + board.unit : ''), cx, y + 158, 22,
          i === 0 ? GOLD : ACC, 'center', false);
    });
    y += BH + 22;
  }

  drawQuip(g, per.quip, y);
  drawFooter(g, server, ACC);
  return done(g.cv, pi);
}
