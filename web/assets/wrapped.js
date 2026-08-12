const BOOT = window.__WGG__ || {};
const EMBED = !!BOOT.embed && window.parent !== window;
const post = (type, extra) => {
  if (!EMBED) return;
  try { window.parent.postMessage({ source: 'wrapped.gg', type, ...extra }, '*'); } catch {}
};
const $ = (id) => document.getElementById(id);
const nf = (n) => Number(n || 0).toLocaleString('en-US');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const DISCORD = 'https://discord.gg/hPRGgWKpTF';
const dcLine = (text) => `<a class="dc-line an d4" href="${DISCORD}" target="_blank" ` +
  `rel="noopener"><span class="i-discord"></span>${text}</a>`;

const safeId = (id) => (/^[a-z0-9_]{1,64}$/.test(String(id)) ? id : null);
const ICO  = (id) => safeId(id) ? `/assets/icons/${id}.png` : null;
const ITEM = (id) => safeId(id) ? `/assets/items/${id}.png` : null;

const MOB_CATS = new Set(['killed', 'killed_by']);
const CAT_FALLBACK = {
  mined: 'mine_stone', killed: 'kill_any', killed_by: 'death',
  crafted: 'craft_tools', used: 'break_tools', picked_up: 'open_container',
};

function iconChain(r, cat) {
  const sprite = r && r.sprite ? ITEM(r.sprite) : null;
  const art = r && r.icon ? ICO(r.icon) : null;
  const generic = ICO(CAT_FALLBACK[cat] || '');

  const mob = [];
  if (MOB_CATS.has(cat) && r && r.sprite) {
    if (cat === 'killed_by') mob.push(ICO(`killed_by_${r.sprite}`));
    mob.push(ICO(`kill_${r.sprite}`));
  }

  const order = MOB_CATS.has(cat) ? [...mob, art, sprite, generic]
                                  : [sprite, art, generic];
  return [...new Set(order.filter(Boolean))];
}

function rowImg(r, cat) {
  const chain = iconChain(r, cat);
  if (!chain.length) return '';
  const [first, ...rest] = chain;
  return `<img src="${first}" alt="" loading="lazy"` +
         (rest.length ? ` data-fallback="${rest.join(' ')}"` : '') + ` />`;
}

const rowChain = (r, cat) => iconChain(r, cat);
const rowIcon = (r, cat) => rowChain(r, cat)[0] || null;
const headUrl = (uuid) => `/head/${encodeURIComponent(uuid)}.png`;

const CARD_MS = 7000;
const BGS = ['mc_mounts', 'mc_copper', 'mc_chaos', 'mc_tiny'].map(n => `/assets/bg/${n}.jpg`);
const PALETTES = [
  ['#7a3a17','#2c1207','#0b0503','#ffb765','#d97a45'],
  ['#1f4467','#0e1c2e','#04070d','#8fd0ff','#4ea3e0'],
  ['#4b2a70','#1e102c','#07040a','#d9a6ff','#a86ee0'],
  ['#1a5340','#0b2219','#030906','#5ded8f','#3ecf72'],
  ['#6b2233','#2c0e17','#090306','#ff9fae','#e0687d'],
  ['#6b4c11','#261b07','#080602','#ffc93c','#e0aa42'],
];

let SERVER = BOOT.server || {};
let cards = [], idx = 0, timer = null, paused = false, animGen = 0, cardPal = null;
let PLAYER = null;

function pctText(r) {
  if (!r) return '';
  const v = r.top_percent;
  if (v >= 10) return 'Top ' + Math.round(v) + '%';
  if (v >= 1) return 'Top ' + v.toFixed(1) + '%';
  return 'Top ' + Math.max(0.1, Number(v.toFixed(1))) + '%';
}
const ctx = (lines) => {
  const rows = lines.filter(Boolean).map(l => `<div>${l}</div>`).join('');
  return rows ? `<div class="ctx an d3">${rows}</div>` : '';
};
function movedTag(r, good = true) {
  if (!r || typeof r.moved !== 'number' || !r.moved) return '';
  const up = r.moved > 0;
  return ` <span class="mv ${up === !!good ? 'up' : 'down'}">` +
         `${up ? '▲' : '▼'}${nf(Math.abs(r.moved))}</span>`;
}

function rankLines(r, noun, good = true) {
  if (!r) return [];
  const out = [];
  if (r.x_avg && r.x_avg >= 1.1) out.push(`<span class="hi">${r.x_avg}x</span> the server average`);
  out.push(`<span class="${r.rank <= 3 ? 'gold' : 'hi'}">${pctText(r)}</span>` +
           (noun ? ` of all ${noun}` : '') + ` &middot; #${nf(r.rank)} of ${nf(r.of)}` +
           movedTag(r, good));
  return out;
}

function sinceText(ts) {
  if (!ts) return '';
  const days = Math.round((Date.now() - ts * 1000) / 86400000);
  if (days <= 1) return 'since yesterday';
  if (days <= 10) return `in the last ${days} days`;
  if (days <= 45) return `in the last ${Math.round(days / 7)} weeks`;
  return 'since ' + new Date(ts * 1000)
    .toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
}
const fun = (t) => `<p class="fun an d4">${t}</p>`;
const pick = (v, table) => { for (const [min, t] of table) if (v >= min) return t; return ''; };
const slot = (iconId, fallback, cls, src) => {
  const c = 'slot' + (cls ? ' ' + cls : '');
  const chain = (Array.isArray(src) ? src : [src]).filter(Boolean);
  if (!chain.length && iconId) chain.push(ICO(iconId));
  const [url, ...rest] = chain;
  return url ? `<div class="${c}"><img src="${url}" alt="" loading="lazy"` +
               (rest.length ? ` data-fallback="${rest.join(' ')}"` : '') + ` /></div>`
             : `<div class="${c}"><b>${fallback || '?'}</b></div>`;
};
function unitVal(v, unit) {
  if (unit === 'cm') return (v / 100000).toFixed(1) + ' km';
  if (unit === 'ticks') return (v / 20 / 3600).toFixed(1) + ' h';
  if (unit === 'tenths_of_heart') return nf(Math.round(v / 10)) + ' hearts';
  return nf(v);
}
function dhm(hours) {
  const total = Math.round(hours * 60);
  const d = Math.floor(total / 1440), h = Math.floor((total % 1440) / 60), m = total % 60;
  return (d ? d + 'd ' : '') + h + 'h ' + m + 'm';
}
function motes(n = 10) {
  let h = '';
  for (let i = 0; i < n; i++) {
    h += `<i style="left:${(Math.random() * 100).toFixed(2)}%;` +
         `animation-duration:${(12 + Math.random() * 14).toFixed(1)}s;` +
         `animation-delay:${(-Math.random() * 24).toFixed(1)}s"></i>`;
  }
  return h;
}

function bgFor(i) {
  const p = PALETTES[i % PALETTES.length];
  const img = BGS[(i + Math.floor(i / BGS.length)) % BGS.length];
  return `<div class="bg" style="background-image:url(${img})"></div>` +
    `<div class="tint" style="background:linear-gradient(165deg,${p[0]}b3 0%,${p[1]}e0 58%,${p[2]}f0 100%)"></div>` +
    `<div class="dither"></div><div class="motes">${motes()}</div><div class="vig"></div>`;
}
const bars = (rows, cat) => {
  if (!rows || !rows.length) return '';
  const max = rows[0].count || 1;
  return '<div class="rows an d2">' + rows.slice(0, 4).map(r =>
    `<div><div class="rh">${rowImg(r, cat)}` +
    `<span>${esc(r.label)}</span><b>${nf(r.count)}</b></div>` +
    `<div class="rt"><i data-w="${Math.max(4, (r.count / max) * 100)}"></i></div></div>`).join('') + '</div>';
};

function wireIconFallbacks(root) {
  root.querySelectorAll('img[data-fallback]').forEach((im) => {
    im.addEventListener('error', function next() {
      const rest = (this.dataset.fallback || '').split(' ').filter(Boolean);
      const url = rest.shift();
      this.dataset.fallback = rest.join(' ');
      if (url) this.src = url;
      else { this.removeEventListener('error', next); this.style.visibility = 'hidden'; }
    });
  });
}

function buildCards(p) {
  const name = esc(p.name || 'Player');
  const R = p.rank || {};
  const has = (n) => typeof n === 'number' && n > 0;
  const out = [];
  const sv = esc(SERVER.name || 'this server');
  const d = p.distance || {};

  let seed = 2166136261;
  for (const ch of String(p.uuid || p.name || 'x')) {
    seed ^= ch.charCodeAt(0); seed = Math.imul(seed, 16777619);
  }
  seed = Math.abs(seed);
  const sPick = (arr, salt) => arr[(seed + salt) % arr.length];

  out.push({ html:
    `<img class="head big an" src="${headUrl(p.uuid)}" alt="" />` +
    `<div class="lead an d1">${sv}</div>` +
    `<div class="big sm pop" style="color:#fff">${name}</div>` +
    `<div class="tail an d2">Here is your year, block by block.</div>` +
    `<p class="fun an d4">Tap the right side to keep going.</p>` });

  out.push({ html:
    `<div class="slotrow an">${slot('play', '?', '')}</div>` +
    `<div class="lead an d1">First, the basics</div>` +
    `<div class="big xs an d2">What is this?</div>` +
    `<p class="exp an d3">Minecraft has been keeping score this whole time - every ` +
    `block broken, every mob fought, every centimetre walked.</p>` +
    `<p class="exp an d4">Nobody asked it to. It just did. This is that record on ` +
    `<b>${sv}</b>, read back to you.</p>` });

  if (p.movement && (p.movement.moves.length || p.movement.entered.length)) {
    const m = p.movement;
    const when = sinceText(m.since);
    const rows = m.moves.slice(0, 4).map(x => {
      const up = x.moved > 0;
      return `<div><span class="a ${up === (x.good !== false) ? 'up' : 'down'}">` +
        `${up ? '▲' : '▼'}${nf(Math.abs(x.moved))}</span>` +
        `<span class="l">${esc(x.label)}</span>` +
        `<span class="p">#${nf(x.rank)}, was #${nf(x.was)}</span></div>`;
    }).concat(m.entered.slice(0, 2).map(x =>
      `<div><span class="a new">NEW</span><span class="l">${esc(x.label)}</span>` +
      `<span class="p">#${nf(x.rank)}</span></div>`)).join('');

    const head = m.climbed > 0
      ? { lead: 'You passed', n: m.climbed, unit: m.climbed === 1 ? 'player' : 'players', tail: when }
      : m.entered.length
        ? { lead: 'You turned up on', n: m.entered.length,
            unit: m.entered.length === 1 ? 'new leaderboard' : 'new leaderboards', tail: when }
        : { lead: 'You slipped', n: m.fell, unit: m.fell === 1 ? 'place' : 'places', tail: when };

    out.push({ html:
      `<div class="lead an">${head.lead}</div>` +
      `<div class="num"><span class="big pop" data-count="${head.n}">0</span>` +
      `<span class="unit an d1">${head.unit}</span></div>` +
      `<div class="tail an d2">${head.tail}</div>` +
      `<div class="moves an d3">${rows}</div>` +
      fun(m.climbed >= 25 ? sPick([
            'Somebody has been busy. Several somebodies noticed.',
            'That is not drift. That is a campaign.',
          ], 21)
        : m.climbed > 0 ? sPick([
            'Every place gained came off somebody else. They know.',
            'Quietly, steadily, upwards.',
          ], 22)
        : m.entered.length ? 'New boards, new problems. Welcome to them.'
        : sPick([
            'Everyone else kept playing. That is all this means.',
            'Standing still on a server that did not is how this happens.',
          ], 23)) });
  }

  if (has(p.playtime_hours)) {
    const h = p.playtime_hours;
    out.push({ html:
      `<div class="lead an">You spent</div>` +
      `<div class="num"><span class="big pop" data-count="${Math.round(h)}">0</span>` +
      `<span class="unit an d1">hours</span></div>` +
      `<div class="tail an d2">playing on ${sv}</div>` +
      ctx([`That is <b>${dhm(h)}</b> of your life`].concat(rankLines(R.playtime, 'players'))) +
      fun(h >= 2000 ? sPick([
            `Over three months awake. The extended Lord of the Rings runs 11 hours - you could have watched it ${nf(Math.round(h / 11.4))} times.`,
            'At this point the server should be paying you rent.',
            `${nf(Math.round(h / 24))} full days. Not play sessions. Days.`,
          ], 1)
        : h >= 500 ? sPick([
            `All 201 episodes of The Office, ${nf(Math.max(2, Math.round(h / 74)))} times over. That's what she said.`,
            'Long enough to learn an instrument. You learned redstone instead, which is harder.',
            `${nf(Math.round(h / 24))} days of your life, spent very deliberately.`,
          ], 2)
        : h >= 100 ? sPick([
            'Every Star Wars film back to back, several times over.',
            'Enough hours that "just one more" has stopped being true.',
            'Past the point where this counts as a hobby. Welcome.',
          ], 3)
        : h >= 20 ? sPick([
            'About a full season of a show, except you built things.',
            'A solid stretch. The good stuff usually starts around here.',
          ], 4)
        : sPick([
            'Everyone starts somewhere. The first block is the hardest.',
            'Early days. The best part is still in front of you.',
          ], 5)) });
  }

  if (has(p.sessions) && has(p.playtime_hours) && p.sessions >= 3) {
    const avgMin = (p.playtime_hours * 60) / p.sessions;
    out.push({ html:
      `<div class="slotrow an">${slot('open_container', '?', '')}</div>` +
      `<div class="lead an d1">You logged in</div>` +
      `<div class="num"><span class="big pop" data-count="${p.sessions}">0</span>` +
      `<span class="unit an d1">times</span></div>` +
      ctx([`Averaging <b>${avgMin >= 60 ? dhm(avgMin / 60) : Math.round(avgMin) + ' minutes'}</b> a session`]) +
      fun(avgMin >= 240 ? sPick([
            'Four hours at a stretch. "I\'ll log off after this" is a lie you tell yourself.',
            'These are not sessions. These are shifts.',
          ], 6)
        : avgMin >= 90 ? sPick([
            'Long enough to actually finish a project. Occasionally you did.',
            'An hour and a half a go. Respectable. Sustainable, even.',
          ], 7)
        : sPick([
            'Short and frequent. The snack-sized approach to Minecraft.',
            'In, done the chores, out. Efficient.',
          ], 8)) });
  }

  if (d.total_km > 0) {
    const MODES = [['walk','Walking','walk'],['sprint','Sprinting','sprint'],['elytra','Elytra','aviate'],
                   ['boat','Boat','ride_boat'],['minecart','Minecart','ride_minecart'],
                   ['horse','Horse','ride_horse'],['swim','Swimming','swim'],
                   ['strider','Strider','ride_strider'],['pig','Pig','ride_pig']];
    const present = MODES.filter(m => d[m[0]] > 0).sort((a, b) => d[b[0]] - d[a[0]]).slice(0, 4);
    const max = present.length ? d[present[0][0]] : 1;
    const top = present.length ? present[0][0] : null;
    out.push({ html:
      `<div class="lead an">You travelled</div>` +
      `<div class="num"><span class="big pop" data-count="${d.total_km.toFixed(1)}">0</span>` +
      `<span class="unit an d1">km</span></div>` +
      '<div class="rows an d2">' + present.map(m =>
        `<div><div class="rh"><img src="${ICO(m[2])}" alt="" loading="lazy" />` +
        `<span>${m[1]}</span><b>${d[m[0]].toFixed(1)} km</b></div>` +
        `<div class="rt"><i data-w="${Math.max(4, (d[m[0]] / max) * 100)}"></i></div></div>`).join('') + '</div>' +
      ctx(rankLines(R.distance, 'travellers')) +
      fun(top === 'elytra' ? sPick([
            'Elytra is not a tool. Elytra is a personality.',
            'Most of that never touched the ground, and you know it.',
            'Rockets are a consumable. Your rocket usage is a lifestyle.',
          ], 9)
        : top === 'pig' ? 'Mostly by pig. There is no note here that improves on that.'
        : top === 'boat' ? sPick([
            'A life on the ocean wave, at 8 blocks a second.',
            'Ice boat or bust.',
          ], 10)
        : d.total_km >= 4000 ? `Further than New York to Rome - ${nf(Math.round(d.total_km / 42.195))} marathons, without leaving your chair.`
        : d.total_km >= 400 ? `That is ${nf(Math.round(d.total_km / 42.195))} full marathons. Sitting down.`
        : d.total_km >= 42 ? 'More than a marathon (42.195 km). Sitting down.'
        : sPick(['A decent hike, if hiking involved creepers.',
                 'Home is where the bed is.'], 11)) });
  }

  if (d.fall > 0.2) {
    const blocks = Math.round(d.fall * 1000);
    out.push({ html:
      `<div class="slotrow an">${slot('fall', '?', '')}</div>` +
      `<div class="lead an d1">You fell</div>` +
      `<div class="num"><span class="big pop" data-count="${blocks}">0</span>` +
      `<span class="unit an d1">blocks</span></div>` +
      ctx([`Straight down, on purpose or otherwise`]) +
      fun(sPick([
        'Fall damage starts after three blocks and stops mattering after about twenty-three, because by then you are dead.',
        'The world is 384 blocks tall now. You have been making the most of it.',
        'Gravity: undefeated since 2009.',
        'Some of these were shortcuts. Most were not.',
      ], 12)) });
  }

  if (has(p.mobs_killed) || has(p.deaths)) {
    const kills = p.mobs_killed || 0, deaths = p.deaths || 0;
    const kd = deaths > 0 ? kills / deaths : kills;
    const top = p.top_killed && p.top_killed[0], nem = p.nemesis && p.nemesis[0];
    out.push({ html:
      `<div class="lead an">In combat, you</div>` +
      `<div class="split an d1">` +
        `<div class="sc"><div class="sn${nf(kills).length > 6 ? ' long' : ''}">${nf(kills)}</div><div class="sl">kills</div></div>` +
        `<div class="si"><img src="${ICO('kill_any')}" alt="" /><img src="${ICO('death')}" alt="" /></div>` +
        `<div class="sc"><div class="sn${nf(deaths).length > 6 ? ' long' : ''}">${nf(deaths)}</div><div class="sl">deaths</div></div>` +
      `</div>` +
      `<div class="tail an d2">K/D: <span style="color:var(--acc)">${kd >= 100 ? nf(Math.round(kd)) : kd.toFixed(1)}</span></div>` +
      `<div class="facts an d3">` +
        (top ? `<div>${rowImg(top, 'killed')}Most killed: <b>${esc(top.label)}</b> x${nf(top.count)}</div>` : '') +
        (nem ? `<div>${rowImg(nem, 'killed_by')}Biggest threat: <b>${esc(nem.label)}</b> x${nf(nem.count)}</div>` : '') +
      `</div>` +
      ctx(rankLines(R.killed, 'fighters')) +
      fun(kd >= 1000 ? sPick([
            'This is not combat any more, it is agriculture. The mobs know.',
            'Somewhere there is a very efficient dark room with your name on it.',
          ], 13)
        : kd >= 100 ? 'A K/D in the hundreds. Less a warrior, more a processing facility.'
        : kd >= 20 ? 'A K/D above 20. Most shooter pros would take that.'
        : kd >= 5 ? 'Comfortably positive. The mobs have learned to avoid you.'
        : kd >= 1 ? 'More wins than losses. That is all anyone can ask.'
        : sPick(['It is not about the deaths. It is about what you built between them.',
                 'Every one of those deaths was a lesson. You may not have taken notes.'], 14)) });
  }

  if (p.nemesis && p.nemesis.length && has(p.deaths) && p.deaths >= 3) {
    const n0 = p.nemesis[0];
    out.push({ html:
      `<div class="slotrow an">${slot(null, '!', '', [...rowChain(n0, 'killed_by'), ICO('death')])}</div>` +
      `<div class="lead an d1">Your nemesis</div>` +
      `<div class="big sm pop">${esc(n0.label)}</div>` +
      `<div class="tail an d2">got you <b>${nf(n0.count)}</b> ${n0.count === 1 ? 'time' : 'times'}</div>` +
      bars(p.nemesis, 'killed_by') +
      fun(/creeper/i.test(n0.label) ? sPick([
            'That hissing sound will follow you into other games.',
            'A creeper at point blank does up to 49 damage. You have the receipts.',
          ], 15)
        : /fall|gravity|void/i.test(n0.label) ? 'Not a mob. Just the ground, doing its job.'
        : /lava|fire|magma/i.test(n0.label) ? 'The Nether does not negotiate.'
        : /warden/i.test(n0.label) ? 'Nobody beats the Warden. You run from the Warden.'
        : sPick([`Somewhere out there, a ${esc(n0.label)} is telling this story too.`,
                 'Everyone has one. This one is yours.'], 16)) });
  }

  if (has(p.damage_dealt) && has(p.damage_taken)) {
    const dealt = Math.round(p.damage_dealt / 10), taken = Math.round(p.damage_taken / 10);
    out.push({ html:
      `<div class="lead an">Hearts</div>` +
      `<div class="split an d1">` +
        `<div class="sc"><div class="sn${nf(dealt).length > 6 ? ' long' : ''}">${nf(dealt)}</div><div class="sl">dealt</div></div>` +
        `<div class="si"><img src="${ICO('damage_dealt')}" alt="" /><img src="${ICO('damage_taken')}" alt="" /></div>` +
        `<div class="sc"><div class="sn${nf(taken).length > 6 ? ' long' : ''}">${nf(taken)}</div><div class="sl">taken</div></div>` +
      `</div>` +
      ctx(rankLines(R.damage, 'players')) +
      fun(sPick([
        `The Ender Dragon has 200 health - 100 hearts. You have dealt that ${nf(Math.max(1, Math.round(dealt / 100)))} times over.`,
        'One heart is two points of health. Both of these numbers are bigger than they look.',
        dealt > taken * 3 ? 'Overwhelmingly one-directional. Good.' : 'A fair fight, more or less.',
      ], 17)) });
  }

  if (p.top_mined && p.top_mined.length) {
    const t = p.top_mined[0];
    out.push({ html:
      `<div class="slotrow an">${slot(null, '1', '', rowChain(t, 'mined'))}</div>` +
      `<div class="lead an d1">You broke</div>` +
      `<div class="num"><span class="big pop" data-count="${p.blocks_mined}">0</span>` +
      `<span class="unit an d1">blocks</span></div>` +
      bars(p.top_mined, 'mined') +
      ctx(rankLines(R.mined, 'miners')) +
      fun(p.blocks_mined >= 100000 ? sPick([
            'You have personally lowered the sea level of at least one biome.',
            `${nf(Math.round(p.blocks_mined / 3456))} double chests, filled to the lid.`,
            'Somewhere out there is a hole visible from orbit.',
          ], 18)
        : p.blocks_mined >= 3456 ? `${nf(Math.round(p.blocks_mined / 3456))} double chests, filled to the lid.`
        : `That is ${nf(Math.max(1, Math.round(p.blocks_mined / 64)))} stacks - a double chest would still have room.`) });
  }

  if (p.top_crafted && p.top_crafted.length && has(p.items_crafted)) {
    out.push({ html:
      `<div class="slotrow an">${slot(null, '1', '', rowChain(p.top_crafted[0], 'crafted'))}</div>` +
      `<div class="lead an d1">You crafted</div>` +
      `<div class="num"><span class="big pop" data-count="${p.items_crafted}">0</span>` +
      `<span class="unit an d1">items</span></div>` +
      bars(p.top_crafted, 'crafted') +
      ctx(rankLines(R.crafted, 'crafters')) +
      fun(sPick([
        'The crafting table files you as a dependent.',
        'A statistically significant portion of that is sticks. It always is.',
        'Somewhere in there is a stack of something you will never use and cannot throw away.',
        'Nobody has ever had enough chests. You tried anyway.',
      ], 19)) });
  }

  if (has(p.items_used) && p.top_used && p.top_used.length) {
    out.push({ html:
      `<div class="slotrow an">${slot(null, '1', '', rowChain(p.top_used[0], 'used'))}</div>` +
      `<div class="lead an d1">You reached for something</div>` +
      `<div class="num"><span class="big pop" data-count="${p.items_used}">0</span>` +
      `<span class="unit an d1">times</span></div>` +
      `<div class="tail an d2">placing, swinging, eating and drinking</div>` +
      bars(p.top_used, 'used') +
      ctx(rankLines(R.used, 'players')) +
      fun(sPick([
        'Every block placed, every swing taken, every questionable stew eaten.',
        'This number is mostly torches. It is always mostly torches.',
      ], 20)) });
  }

  (function () {
    const LIST = [['playtime','Play Time','play'], ['mined','Blocks Mined','mine_stone'],
                  ['killed','Mob Kills','kill_any'], ['distance','Distance','walk'],
                  ['crafted','Crafting','craft_tools'], ['used','Item Use','break_tools']];
    const rows = LIST.map(([k, l, i]) => [R[k], l, i]).filter(x => x[0]);
    if (rows.length < 3) return;
    rows.sort((a, b) => a[0].top_percent - b[0].top_percent);
    const podium = rows.filter(r => r[0].rank <= 3).length;
    out.push({ html:
      `<div class="big xs an">Your Rankings</div>` +
      `<div class="lead an d1" style="margin-top:10px">Where you place on ${sv}</div>` +
      '<div class="ranks an d2">' + rows.slice(0, 6).map(([r, l, i]) => {
        const g = r.rank <= 3 ? ' gold' : '';
        return `<div class="rank"><div class="rn${g}">#${r.rank}</div>` +
          `<img src="${ICO(i)}" alt="" loading="lazy" /><div class="rl">${l}</div>` +
          `<div class="rp${g}">${r.rank <= 3 ? 'Top 3!' : pctText(r)}</div></div>`;
      }).join('') + '</div>' +
      fun(podium ? 'Podium finish. Somewhere a crowd is going wild.'
                 : 'No podiums, but every one of these is a leaderboard you are on.') });
  })();

  if (p.signature_award) {
    const a = p.signature_award;
    out.push({ html:
      `<div class="slotrow an">${slot(a.id, '#1', '')}</div>` +
      `<div class="lead an d1">Your signature stat</div>` +
      `<div class="big sm pop">${esc(a.title)}</div>` +
      (a.desc ? `<div class="tail an d2">${esc(a.desc)}</div>` : '') +
      ctx([`<b>${unitVal(a.value, a.unit)}</b>`,
           `<span class="${a.rank <= 3 ? 'gold' : 'hi'}">#${a.rank}</span> of ${nf(a.of)} players`]) +
      fun(a.rank === 1 ? 'Nobody on this server does this more than you. Nobody.'
        : a.rank <= 3 ? 'Top three. Close enough to first to be annoying about it.'
        : 'This is the leaderboard you quietly own.') });
  }

  if (p.awards && p.awards.length >= 3) {
    out.push({ html:
      `<div class="big xs an">Your Trophy Shelf</div>` +
      `<div class="lead an d1" style="margin-top:10px">Where you rank best</div>` +
      '<div class="ranks an d2">' + p.awards.slice(0, 5).map(a => {
        const g = a.rank <= 3 ? ' gold' : '';
        return `<div class="rank"><div class="rn${g}">#${a.rank}</div>` +
          `<img src="${ICO(a.id)}" alt="" loading="lazy" />` +
          `<div class="rl">${esc(a.title)}${a.desc ? `<em>${esc(a.desc)}</em>` : ''}</div>` +
          `<div class="rp${g}">${unitVal(a.value, a.unit)}</div></div>`;
      }).join('') + '</div>' +
      fun('Every tracked stat, ranked. These are the ones with your name near the top.') });
  }

  const simple = [
    [p.jumps, 'jump', 'You jumped', 'times', R.jumps, null, [
      'A jump clears 1.25 blocks. The world is 384 tall. You did the maths the hard way.',
      'Some of those were to get somewhere. Most were just because.',
      'Bunny-hopping is not faster. It has never been faster. You did it anyway.',
    ]],
    [p.trades, 'trade', 'You made', 'trades', null, null, [
      'Villagers restock twice a day and hold a grudge if you hit them.',
      'The emerald economy: entirely fictional, deeply serious.',
      'Somewhere a librarian is still refusing to offer Mending.',
    ]],
    [p.enchants, 'enchant', 'You enchanted', 'items', null, null, [
      'Fifteen bookshelves around the table gets you level 30. Fourteen gets you disappointment.',
      'The enchanting language is a real font, and it says nothing useful.',
      'Half of these were rerolls and you know it.',
    ]],
    [p.chests_opened, 'open_container', 'You opened', 'chests', null, null, [
      'A double chest holds 3,456 items. Nobody has ever had enough storage.',
      'The eternal question: which chest was it in?',
      'Sorting systems exist. You have opinions about them.',
    ]],
    [p.tools_broken, 'break_tools', 'You wore out', 'tools', null, null, [
      'A diamond pickaxe lasts 1,561 swings. Netherite gets 2,031. Each one died doing what it loved.',
      'Mending exists specifically so this number stops going up. It did not.',
      'That snapping sound, over and over.',
    ]],
    [p.times_slept, 'sleep', 'You slept', 'nights', null, null, [
      'Three in-game days without a bed and a phantom comes looking.',
      'A night skipped is 5 minutes 50 seconds you got back.',
      'Setting a spawn point is the closest Minecraft gets to insurance.',
    ]],
    [p.animals_bred, 'breed', 'You bred', 'animals', null, null, [
      'It takes two of anything and a handful of wheat. Nature is simple here.',
      'Somewhere on this server is a pen you have not visited in months.',
    ]],
    [p.items_picked_up, 'open_container', 'You picked up', 'items', null, null, [
      'Items despawn after five minutes. These are the ones that made it.',
      'Every single one of these was, briefly, on the ground.',
    ]],
  ];
  for (const [v, icon, lead, unit, rank, noun, jokes] of simple) {
    if (!has(v)) continue;
    out.push({ simple: true, html:
      `<div class="slotrow an">${slot(icon, '?', '')}</div>` +
      `<div class="lead an d1">${lead}</div>` +
      `<div class="num"><span class="big pop" data-count="${v}">0</span>` +
      `<span class="unit an d1">${unit}</span></div>` +
      ctx(rankLines(rank, noun)) + fun(sPick(jokes, out.length + 3)) });
  }

  if (window.__SUMMARY__) {
    const s = window.__SUMMARY__;
    const shareH = has(p.playtime_hours) && s.playtime_hours
      ? (p.playtime_hours / s.playtime_hours) * 100 : 0;
    out.push({ html:
      `<div class="lead an">Meanwhile, all of ${sv}</div>` +
      `<div class="num"><span class="big pop" data-count="${Math.round(s.playtime_hours)}">0</span>` +
      `<span class="unit an d1">hours</span></div>` +
      `<div class="tail an d2">played between everyone</div>` +
      ctx([`<b>${nf(s.players_active)}</b> players with a Wrapped`,
           `<b>${nf(s.blocks_mined)}</b> blocks broken together`,
           shareH >= 0.1 ? `<span class="hi">${shareH.toFixed(1)}%</span> of it was you` : null]) +
      fun(shareH >= 5 ? 'A meaningful fraction of this server is, statistically, you.'
                      : 'Somewhere out there is a very large hole, and you helped.') });
  }

  out.push({ confetti: true, html:
    `<img class="head big an" src="${headUrl(p.uuid)}" alt="" />` +
    `<div class="lead an d1">That was your year</div>` +
    `<div class="big sm pop" style="color:#fff">Thanks for playing</div>` +
    `<p class="fun an d3">on ${sv}, ${name}.</p>` +
    `<div class="acts an d4">` +
      `<button class="b solid" id="cardBtn" type="button">Get my player card</button>` +
      `<button class="b" id="againBtn" type="button">Watch again</button>` +
      `<button class="b" id="doneBtn" type="button">Done</button>` +
    `</div>` +
    dcLine('Something here look wrong? Tell us on Discord') });

  const MAX_CARDS = 20;
  while (out.length > MAX_CARDS) {
    const i = out.map(c => !!c.simple).lastIndexOf(true);
    if (i < 0) break;
    out.splice(i, 1);
  }

  return out;
}

function buildServerCards(s) {
  const out = [];
  const sv = esc(SERVER.name || 'this server');
  const has = (n) => typeof n === 'number' && n > 0;

  const board = (rows, unit, limit = 8, good = true) => {
    if (!rows || !rows.length) return '';
    return '<div class="ranks an d2">' + rows.slice(0, limit).map(r => {
      const g = r.rank <= 3 ? ' gold' : '';
      const mv = typeof r.moved === 'number' && r.moved
        ? `<span class="mv ${(r.moved > 0) === good ? 'up' : 'down'}">` +
          `${r.moved > 0 ? '▲' : '▼'}${nf(Math.abs(r.moved))}</span>`
        : (r.was === null && typeof r.moved !== 'undefined'
            ? '<span class="mv new">NEW</span>' : '');
      return `<div class="rank"><div class="rn${g}">#${r.rank}</div>` +
        `<img src="${headUrl(r.uuid)}" alt="" loading="lazy" class="mini" />` +
        `<div class="rl">${esc(r.name || 'Unknown')}</div>` +
        `<div class="rp${g}">${nf(r.value)}${unit ? ' ' + unit : ''}${mv}</div></div>`;
    }).join('') + '</div>';
  };

  out.push({ html:
    `<img class="head big an" src="${esc(SERVER.logo || DEFAULT_ICON)}" alt="" />` +
    `<div class="lead an d1">The whole server</div>` +
    `<div class="big sm pop" style="color:#fff">${sv}</div>` +
    `<div class="tail an d2">Everything everyone did, added up.</div>` +
    `<p class="fun an d4">Tap the right side to keep going.</p>` });

  const bd = SERVER.birthday;
  if (bd) {
    const born = new Date(bd.born_at * 1000)
      .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    out.push({ confetti: bd.is_birthday, html: bd.is_birthday
      ? `<div class="lead an">Today, ${sv} turns</div>` +
        `<div class="num"><span class="big pop" data-count="${bd.turning}">0</span>` +
        `<span class="unit an d1">${bd.turning === 1 ? 'year old' : 'years old'}</span></div>` +
        `<div class="tail an d2">Created ${born}</div>` +
        ctx([`<b>${nf(bd.day_number)}</b> days of it so far`]) +
        fun(bd.turning >= 5 ? 'Older than most things on the internet that still work.'
          : bd.turning >= 3 ? 'Three years is roughly forever in server terms. Still here.'
          : 'One year down. The chunks remember.')
      : `<div class="lead an">${sv} has been running for</div>` +
        `<div class="num"><span class="big pop" data-count="${bd.day_number}">0</span>` +
        `<span class="unit an d1">days</span></div>` +
        `<div class="tail an d2">Created ${born}</div>` +
        ctx([bd.days_until <= 30
              ? `Turns <span class="gold">${bd.next_age}</span> in <b>${nf(bd.days_until)}</b> days`
              : `Turns <span class="gold">${bd.next_age}</span> on <b>${new Date(bd.next_at * 1000)
                  .toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })}</b>`]) +
        fun(bd.age_days >= 1825 ? 'Every one of those days is still in the terrain somewhere.'
          : bd.age_days >= 365 ? 'Long enough that the spawn area is a historical site.'
          : 'Early days. The good holes are still ahead of you.') });
  }

  if (has(s.players_active)) {
    out.push({ html:
      `<div class="lead an">This year, ${sv} had</div>` +
      `<div class="num"><span class="big pop" data-count="${s.players_active}">0</span>` +
      `<span class="unit an d1">players</span></div>` +
      ctx([has(s.avg_playtime_hours) ? `Averaging <b>${dhm(s.avg_playtime_hours)}</b> each` : null]) +
      fun(s.players_active >= 1000 ? 'A small town, with worse infrastructure and better lighting.'
        : s.players_active >= 100 ? 'A proper community. Most of them have never met.'
        : 'Small server, big year.') });
  }

  if (has(s.playtime_hours)) {
    const years = s.playtime_hours / 8760;
    out.push({ html:
      `<div class="lead an">Together you played</div>` +
      `<div class="num"><span class="big pop" data-count="${Math.round(s.playtime_hours)}">0</span>` +
      `<span class="unit an d1">hours</span></div>` +
      ctx([years >= 1 ? `That is <b>${years.toFixed(1)} years</b> of continuous play` : null,
           has(s.avg_playtime_hours) ? `<b>${s.avg_playtime_hours}</b> hours each on average` : null]) +
      fun(years >= 20 ? 'Longer than most people have been alive. Spent entirely on cubes.'
        : years >= 1 ? 'If one person did this alone they would still be going.'
        : 'Every hour of it voluntary.') });
  }

  if (s.leaderboards && s.leaderboards.playtime && s.leaderboards.playtime.length) {
    out.push({ html:
      `<div class="big xs an">Most hours played</div>` +
      `<div class="lead an d1" style="margin-top:10px">The ones who never left</div>` +
      board(s.leaderboards.playtime, 'h') +
      fun(s.movement_since
        ? `Arrows are movement ${sinceText(s.movement_since)}.`
        : 'Load-bearing members of this server.') });
  }

  if (has(s.blocks_mined)) {
    out.push({ html:
      `<div class="lead an">You broke</div>` +
      `<div class="num"><span class="big pop" data-count="${s.blocks_mined}">0</span>` +
      `<span class="unit an d1">blocks</span></div>` +
      bars(s.top_mined, 'mined') +
      fun(`${nf(Math.round(s.blocks_mined / 3456))} double chests worth. Somewhere out there is a ` +
          'hole with everybody\'s name on it.') });
  }

  if (s.leaderboards && s.leaderboards.mined && s.leaderboards.mined.length) {
    out.push({ html:
      `<div class="big xs an">Most blocks mined</div>` +
      `<div class="lead an d1" style="margin-top:10px">The excavation department</div>` +
      board(s.leaderboards.mined) +
      fun('These are the people responsible for the terrain damage.') });
  }

  if (has(s.mobs_killed)) {
    out.push({ html:
      `<div class="lead an">Between you, you defeated</div>` +
      `<div class="num"><span class="big pop" data-count="${s.mobs_killed}">0</span>` +
      `<span class="unit an d1">mobs</span></div>` +
      bars(s.top_killed, 'killed') +
      fun('The mob spawning algorithm has been working overtime.') });
  }

  if (s.leaderboards && s.leaderboards.killed && s.leaderboards.killed.length) {
    out.push({ html:
      `<div class="big xs an">Most mobs defeated</div>` +
      `<div class="lead an d1" style="margin-top:10px">Do not stand near these people</div>` +
      board(s.leaderboards.killed) +
      fun('Somewhere is a very efficient dark room. Several, probably.') });
  }

  if (has(s.deaths)) {
    out.push({ html:
      `<div class="lead an">And you died</div>` +
      `<div class="num"><span class="big pop" data-count="${s.deaths}">0</span>` +
      `<span class="unit an d1">times</span></div>` +
      bars(s.top_deaths, 'killed_by') +
      fun('Every one of those was somebody\'s worst moment of the week.') });
  }

  if (s.leaderboards && s.leaderboards.deaths && s.leaderboards.deaths.length) {
    out.push({ html:
      `<div class="big xs an">Died the most</div>` +
      `<div class="lead an d1" style="margin-top:10px">Bravery, or something like it</div>` +
      board(s.leaderboards.deaths, '', 8, false) +
      fun('Respawning is free. Getting your stuff back is not.') });
  }

  if (has(s.distance_km)) {
    out.push({ html:
      `<div class="lead an">You travelled</div>` +
      `<div class="num"><span class="big pop" data-count="${Math.round(s.distance_km)}">0</span>` +
      `<span class="unit an d1">km</span></div>` +
      ctx([s.distance_km >= 40075
            ? `That is <b>${(s.distance_km / 40075).toFixed(1)}x</b> around the Earth`
            : `The Earth is 40,075 km around, for scale`]) +
      fun('Nobody left their chair.') });
  }

  if (s.leaderboards && s.leaderboards.distance && s.leaderboards.distance.length) {
    out.push({ html:
      `<div class="big xs an">Furthest travelled</div>` +
      `<div class="lead an d1" style="margin-top:10px">Spawn is a rumour to these people</div>` +
      board(s.leaderboards.distance, 'km') +
      fun('Elytra: not a tool, a personality.') });
  }

  if (has(s.items_crafted)) {
    out.push({ html:
      `<div class="lead an">You crafted</div>` +
      `<div class="num"><span class="big pop" data-count="${s.items_crafted}">0</span>` +
      `<span class="unit an d1">items</span></div>` +
      bars(s.top_crafted, 'crafted') +
      fun('A statistically significant portion of that is sticks. It always is.') });
  }

  if (s.leaderboards && s.leaderboards.crafted && s.leaderboards.crafted.length) {
    out.push({ html:
      `<div class="big xs an">Most items crafted</div>` +
      `<div class="lead an d1" style="margin-top:10px">The supply chain</div>` +
      board(s.leaderboards.crafted) +
      fun('The crafting table files these people as dependents.') });
  }

  (function () {
    const bits = [];
    if (has(s.jumps)) bits.push(['jump', s.jumps, 'jumps']);
    if (has(s.items_used)) bits.push(['break_tools', s.items_used, 'items used']);
    if (has(s.damage_dealt)) bits.push(['damage_dealt', Math.round(s.damage_dealt / 10), 'hearts dealt']);
    if (bits.length < 2) return;
    out.push({ html:
      `<div class="big xs an">Odds and Ends</div>` +
      `<div class="lead an d1" style="margin-top:10px">Everything else, added up</div>` +
      '<div class="ranks an d2">' + bits.map(b =>
        `<div class="odd"><img src="${ICO(b[0])}" alt="" loading="lazy" />` +
        `<div class="rl">${b[2]}</div><div class="rp">${nf(b[1])}</div></div>`).join('') + '</div>' +
      fun('One heart is two points of health, and the Ender Dragon has 200.') });
  })();

  out.push({ confetti: true, html:
    `<img class="head big an" src="${esc(SERVER.logo || DEFAULT_ICON)}" alt="" />` +
    `<div class="lead an d1">That was the year on</div>` +
    `<div class="big sm pop" style="color:#fff">${sv}</div>` +
    `<p class="fun an d3">Now go and find yourself in it.</p>` +
    `<div class="acts an d4">` +
      `<button class="b solid" id="svCardBtn" type="button">Get the server card</button>` +
      `<button class="b" id="mineBtn" type="button">See my own Wrapped</button>` +
      `<button class="b" id="againBtn" type="button">Watch again</button>` +
    `</div>` +
    dcLine('Run a server? Come and say hello on Discord') });

  return out;
}

function show(i) {
  if (i < 0) i = 0;
  if (i >= cards.length) return;
  idx = i;
  const wrap = $('cards');
  [...wrap.children].forEach(c => c.classList.remove('on'));
  const el = wrap.children[idx];
  if (!el) return;
  el.classList.add('on');
  $('count').textContent = `${idx + 1} / ${cards.length}`;

  [...$('bars').children].forEach((b, n) => {
    b.classList.toggle('done', n < idx);
    b.classList.remove('now');
    const fill = b.querySelector('i');
    fill.style.animation = 'none';
    if (n === idx) {
      void fill.offsetWidth;
      fill.style.animation = '';
      b.classList.add('now');
      fill.style.animationDuration = CARD_MS + 'ms';
    }
  });

  countUp(el);
  requestAnimationFrame(() => {
    el.querySelectorAll('.rt i').forEach(bar => { bar.style.width = bar.dataset.w + '%'; });
  });
  if (cards[idx].confetti) burst(el);
  restart();
}

function countUp(el) {
  const gen = ++animGen;
  el.querySelectorAll('[data-count]').forEach(node => {
    const raw = node.dataset.count, target = parseFloat(raw);
    if (!isFinite(target)) return;
    const dec = raw.includes('.') ? 1 : 0;
    const fmt = (v) => v.toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const final = fmt(target);
    node.style.minWidth = final.length + 'ch';
    node.classList.remove('n7', 'n9');
    if (final.length >= 9) node.classList.add('n9');
    else if (final.length >= 7) node.classList.add('n7');
    const dur = 1250;
    let t0 = null;
    node.textContent = fmt(0);
    requestAnimationFrame(function step(now) {
      if (gen !== animGen) return;
      if (t0 === null) t0 = now;
      const k = Math.max(0, Math.min(1, (now - t0) / dur));
      node.textContent = fmt(target * (1 - Math.pow(1 - k, 3)));
      if (k < 1) requestAnimationFrame(step);
      else node.textContent = final;
    });
  });
}

function burst(el) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('div');
  c.className = 'confetti';
  const cols = ['#5ded8f', '#8fd0ff', '#d9a6ff', '#ffb765', '#ffc93c', '#ffffff'];
  let h = '';
  for (let i = 0; i < 46; i++) {
    h += `<i style="left:${(Math.random() * 100).toFixed(1)}%;background:${cols[i % cols.length]};` +
         `animation-duration:${(2.4 + Math.random() * 2.2).toFixed(1)}s;` +
         `animation-delay:${(Math.random() * 1.1).toFixed(1)}s"></i>`;
  }
  c.innerHTML = h;
  el.appendChild(c);
  setTimeout(() => c.remove(), 7000);
}

const restart = () => {
  clearTimeout(timer);
  if (paused || idx >= cards.length - 1) return;
  timer = setTimeout(() => show(idx + 1), CARD_MS);
};
const next = () => show(idx + 1);
const prev = () => show(idx - 1);

function play(list, url) {
  cards = list;
  $('cards').innerHTML = cards.map((c, i) =>
    `<section class="card" style="--acc:${PALETTES[i % PALETTES.length][3]};--acc-2:${PALETTES[i % PALETTES.length][4]}">` +
    bgFor(i) + `<div class="in">${c.html}</div></section>`).join('');
  $('bars').innerHTML = cards.map(() => '<div class="sb"><i></i></div>').join('');
  wireIconFallbacks($('cards'));
  $('gate').classList.add('hide');
  $('story').classList.add('on');
  $('story').setAttribute('aria-hidden', 'false');
  $('load').style.display = 'none';

  const cb = $('cardBtn'), sc = $('svCardBtn'), ag = $('againBtn'), dn = $('doneBtn'), mn = $('mineBtn');
  if (cb) cb.addEventListener('click', () => showCard());
  if (sc) sc.addEventListener('click', () => showCard());
  if (ag) ag.addEventListener('click', () => show(0));
  if (dn) dn.addEventListener('click', close);
  if (mn) mn.addEventListener('click', close);

  show(0);
  if (EMBED) post('open');
  else history.replaceState(null, '', url);
}

function open(p) {
  PLAYER = p;
  cardPal = null;
  play(buildCards(p), `/${BOOT.slug}/${encodeURIComponent(p.name || '')}`);
}

function openServer() {
  const s = window.__SUMMARY__;
  if (!s) { $('gateMsg').textContent = 'The server summary is not ready yet.'; return; }
  PLAYER = null;
  cardPal = null;
  play(buildServerCards(s), `/${BOOT.slug}#server`);
}

function close() {
  clearTimeout(timer);
  $('story').classList.remove('on');
  $('story').setAttribute('aria-hidden', 'true');
  $('gate').classList.remove('hide');
  if (EMBED) { post('close'); sendHeight(); }
  else history.replaceState(null, '', `/${BOOT.slug}`);
  if (PLAYER === null && !EMBED) setTimeout(() => $('gateInput').focus(), 60);
}

async function load(rawName) {
  const name = String(rawName || '').trim();
  if (!name) return;
  $('gateMsg').textContent = '';
  $('load').style.display = 'grid';
  $('story').classList.add('on');
  try {
    const res = await fetch(`/v1/p/${encodeURIComponent(BOOT.slug)}/${encodeURIComponent(name)}`);
    if (!res.ok) {
      const b = await res.json().catch(() => ({}));
      $('story').classList.remove('on');
      $('load').style.display = 'none';
      $('gateMsg').textContent = b.message || 'Could not find that player.';
      suggest(name);
      return;
    }
    const data = await res.json();
    SERVER = data.server || SERVER;
    open(data.player);
  } catch (e) {
    $('story').classList.remove('on');
    $('load').style.display = 'none';
    $('gateMsg').textContent = 'Something went wrong. Try again.';
  }
}

let suggestTimer = null;
function suggest(q) {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(async () => {
    try {
      const res = await fetch(`/v1/s/${encodeURIComponent(BOOT.slug)}?q=${encodeURIComponent(q)}`);
      if (!res.ok) return;
      const d = await res.json();
      $('gateSugg').innerHTML = (d.matches || []).slice(0, 6)
        .map(m => `<button type="button" data-n="${esc(m.name)}">${esc(m.name)}</button>`).join('');
    } catch {}
  }, 220);
}

$('gateForm').addEventListener('submit', e => { e.preventDefault(); load($('gateInput').value); });
$('gateInput').addEventListener('input', e => {
  const v = e.target.value.trim();
  if (v.length >= 2) suggest(v); else $('gateSugg').innerHTML = '';
});
$('gateSugg').addEventListener('click', e => {
  const b = e.target.closest('button[data-n]');
  if (b) { $('gateInput').value = b.dataset.n; load(b.dataset.n); }
});
$('home').addEventListener('click', close);
$('close').addEventListener('click', close);
const gated = (fn) => (...a) => { if (!$('modal').classList.contains('on')) fn(...a); };
$('zr').addEventListener('click', gated(next));
$('zl').addEventListener('click', gated(prev));

$('story').addEventListener('click', gated((e) => {
  const r = $('stage').getBoundingClientRect();
  if (e.clientX >= r.left && e.clientX < r.right) return;
  (e.clientX < r.left ? prev : next)();
}));
$('mBack').addEventListener('click', closeCard);

document.addEventListener('keydown', e => {
  if (!$('story').classList.contains('on')) return;
  if ($('modal').classList.contains('on')) { if (e.key === 'Escape') closeCard(); return; }
  if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); next(); }
  else if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'Escape') close();
});
['pointerdown', 'pointerup', 'pointercancel'].forEach(ev => {
  $('story').addEventListener(ev, e => {
    if (e.target.closest('.b, .x, .home')) return;
    paused = (ev === 'pointerdown');
    const fill = $('bars').querySelector('.sb.now i');
    if (fill) fill.style.animationPlayState = paused ? 'paused' : 'running';
    if (paused) clearTimeout(timer); else restart();
  });
});
let sx = 0;
$('story').addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
$('story').addEventListener('touchend', e => {
  const dx = e.changedTouches[0].clientX - sx;
  if (Math.abs(dx) > 60) (dx < 0 ? next() : prev());
}, { passive: true });

import { renderCard, renderServerCard } from '/assets/card.js';

async function showCard() {
  const p = PLAYER;
  const s = window.__SUMMARY__;
  if (!p && !s) return;
  const btn = p ? $('cardBtn') : $('svCardBtn');
  const label = p ? 'Get my player card' : 'Get the server card';
  paused = true;
  clearTimeout(timer);
  if (btn) btn.textContent = 'Building...';
  let cv;
  try { cv = p ? await renderCard(p, SERVER, cardPal) : await renderServerCard(s, SERVER, cardPal); }
  catch (e) { if (btn) btn.textContent = 'Could not build card'; paused = false; restart(); return; }
  if (btn) btn.textContent = label;

  const holder = $('holder');
  holder.innerHTML = '';
  holder.appendChild(cv);
  $('modal').classList.add('on');

  const sw = $('swatches');
  if (!sw.dataset.built) {
    sw.dataset.built = '1';
    sw.innerHTML = PALETTES.map((q, i) =>
      `<button type="button" data-pal="${i}" aria-label="Colour ${i + 1}" ` +
      `style="background:linear-gradient(135deg,${q[0]} 0%,${q[3]} 100%)"></button>`).join('');
    sw.addEventListener('click', e => {
      const b = e.target.closest('button[data-pal]');
      if (!b) return;
      cardPal = Number(b.dataset.pal);
      showCard();
    });
  }
  const active = cv.dataset.pal != null ? Number(cv.dataset.pal) : (cardPal == null ? 0 : cardPal);
  [...sw.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === active)));

  const safeName = ((p ? p.name : SERVER.slug || BOOT.slug) || (p ? 'player' : 'server'))
    .replace(/[^a-z0-9_-]/gi, '');
  $('mDown').onclick = () => cv.toBlob(blob => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `wrapped-${safeName}.jpg`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }, 'image/jpeg', 0.86);

  $('mCopy').onclick = () => {
    const b = $('mCopy');
    const flash = (m) => { b.textContent = m; setTimeout(() => b.textContent = 'Copy image', 2200); };
    if (!navigator.clipboard || !window.ClipboardItem) return flash('Use Download');
    cv.toBlob(blob => navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      .then(() => flash('Copied - paste in Discord'), () => flash('Use Download')), 'image/png');
  };
}

function closeCard() {
  $('modal').classList.remove('on');
  paused = false;
  restart();
}

$('gateServer').textContent = SERVER.name || 'this server';
document.title = SERVER.name ? `${SERVER.name} - Wrapped` : 'Wrapped';
const DEFAULT_ICON = '/assets/default-icon.png';
{
  const lg = $('gateLogo');
  lg.onload = () => {
    lg.classList.toggle('smooth', lg.naturalWidth > 128 || lg.naturalHeight > 128);
    lg.hidden = false;
  };
  lg.onerror = () => { if (lg.src.indexOf(DEFAULT_ICON) < 0) lg.src = DEFAULT_ICON; };
  lg.alt = `${SERVER.name || 'Server'} icon`;
  lg.src = SERVER.logo || DEFAULT_ICON;
}
let heightTimer = null;
function sendHeight() {
  if (!EMBED) return;
  clearTimeout(heightTimer);
  heightTimer = setTimeout(() => {
    if ($('gate').classList.contains('hide') || $('story').classList.contains('on')) return;
    const box = document.querySelector('.gate-in');
    if (box) post('ready', { height: Math.ceil(box.getBoundingClientRect().height) + 56,
                             name: SERVER.name || null });
  }, 60);
}

if (EMBED) {
  const full = `/${encodeURIComponent(BOOT.slug)}`;
  const home = $('homeLink');
  if (home) { home.href = full; home.target = '_blank'; home.rel = 'noopener'; }
  const sign = document.querySelector('.sign');
  if (sign) {
    sign.innerHTML = `<a href="${full}" target="_blank" rel="noopener">` +
      `made with <span class="h">&hearts;</span> on wrapped.gg</a>`;
  }
  const box = document.querySelector('.gate-in');
  if (box && window.ResizeObserver) new ResizeObserver(sendHeight).observe(box);
  window.addEventListener('load', sendHeight);
  sendHeight();
}

fetch(`/v1/s/${encodeURIComponent(BOOT.slug)}`)
  .then(r => r.ok ? r.json() : null)
  .then(d => {
    if (!d || !d.summary) return;
    window.__SUMMARY__ = d.summary;
    if (d.server) SERVER = { ...SERVER, ...d.server };
    const btn = $('serverBtn');
    if (btn) {
      const wrap = $('serverWrap');
      if (wrap) wrap.hidden = false;
      btn.addEventListener('click', openServer);
    }
    if (location.hash === '#server' && !BOOT.player) openServer();
  })
  .catch(() => {});
if (BOOT.player) load(BOOT.player);
