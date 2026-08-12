export const W = 1200, H = 630;

export const TAGLINE = 'Make your own server’s Wrapped free at wrapped.gg';

export const PALETTES = [
  ['#7a3a17', '#2c1207', '#0b0503', '#ffb765'],
  ['#1f4467', '#0e1c2e', '#04070d', '#8fd0ff'],
  ['#4b2a70', '#1e102c', '#07040a', '#d9a6ff'],
  ['#1a5340', '#0b2219', '#030906', '#5ded8f'],
  ['#6b2233', '#2c0e17', '#090306', '#ff9fae'],
  ['#6b4c11', '#261b07', '#080602', '#ffc93c'],
];

const nf = (n) => Number(n || 0).toLocaleString('en-US');

const el = (style, children) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } });
const col = (style, children) => el({ flexDirection: 'column', ...style }, children);
const txt = (style, children) => el(style, String(children));
const blank = () => el({}, '');

const logoImg = (dataUri, size) => (dataUri ? {
  type: 'img',
  props: { src: dataUri, width: size, height: size, style: { display: 'flex', objectFit: 'contain' } },
} : null);

const footer = (accent) => el({
  alignItems: 'center', justifyContent: 'space-between', width: '100%',
  borderTopWidth: 2, borderTopStyle: 'solid', borderTopColor: 'rgba(255,255,255,0.14)',
  paddingTop: 22,
}, [
  txt({ fontSize: 23, color: 'rgba(255,255,255,0.62)' }, TAGLINE),
  txt({ fontSize: 26, color: accent }, 'wrapped.gg'),
]);

const shell = (pal, children) => col({
  width: '100%', height: '100%', justifyContent: 'space-between', padding: '48px 64px 40px',
  background: `linear-gradient(135deg, ${pal[0]} 0%, ${pal[1]} 55%, ${pal[2]} 100%)`,
  fontFamily: 'Pixel', color: '#fff',
}, children);

const factRow = (facts, accent) => el({ gap: 48 }, facts.map(([v, l]) => col({}, [
  txt({ fontSize: 52, color: accent }, v),
  txt({ fontSize: 21, color: 'rgba(255,255,255,0.5)', marginTop: 6 }, l),
])));

function headlineStats(p) {
  const out = [];
  if (p.playtime_hours > 0) {
    out.push([p.playtime_hours >= 1 ? nf(Math.round(p.playtime_hours))
                                    : p.playtime_hours.toFixed(1), 'HOURS PLAYED']);
  }
  if (p.blocks_mined > 0) out.push([nf(p.blocks_mined), 'BLOCKS MINED']);
  if (p.mobs_killed > 0) out.push([nf(p.mobs_killed), 'MOB KILLS']);
  if (out.length < 3 && p.distance?.total_km > 0) {
    out.push([nf(Math.round(p.distance.total_km)) + ' km', 'TRAVELLED']);
  }
  return out.slice(0, 3);
}

export function playerTemplate({ player, server, pal, logo }) {
  const sig = player.signature_award;
  return shell(pal, [
    el({ alignItems: 'center', gap: 18 }, [
      logoImg(logo, 52),
      txt({ fontSize: 25, letterSpacing: 2, color: 'rgba(255,255,255,0.58)' },
          `${String(server.name).toUpperCase()}  ·  WRAPPED`),
    ].filter(Boolean)),

    col({}, [
      txt({ fontSize: 76, lineHeight: 1.05 }, player.name || 'Player'),
      sig ? txt({ fontSize: 29, marginTop: 10, color: pal[3] },
                `${sig.title} · #${sig.rank} of ${nf(sig.of)}`)
          : blank(),
    ]),

    col({ gap: 26 }, [
      factRow(headlineStats(player), pal[3]),
      footer(pal[3]),
    ]),
  ]);
}

export function serverTemplate({ server, summary, pal, logo, birthday = null }) {
  const party = !!(birthday && birthday.is_birthday);
  const players = Number(server.players || 0);
  const facts = [
    party && [nf(birthday.day_number), 'DAYS OLD'],
    players > 0 && [nf(players), 'PLAYERS'],
    summary?.playtime_hours > 0 && [nf(Math.round(summary.playtime_hours)), 'HOURS PLAYED'],
    summary?.blocks_mined > 0 && [nf(summary.blocks_mined), 'BLOCKS MINED'],
  ].filter(Boolean).slice(0, 3);

  const eyebrow = party
    ? `${birthday.turning} ${birthday.turning === 1 ? 'YEAR' : 'YEARS'} OLD TODAY`
    : 'A YEAR IN REVIEW';
  const subtitle = party
    ? `Running since ${new Date(birthday.born_at * 1000).toLocaleDateString('en-GB',
        { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}.`
    : 'Find yourself. Every player has a page.';

  return shell(pal, [
    txt({ fontSize: 25, letterSpacing: 2, color: party ? pal[3] : 'rgba(255,255,255,0.58)' },
        eyebrow),

    el({ alignItems: 'center', gap: 30 }, [
      logoImg(logo, 124),
      col({ flexShrink: 1 }, [
        txt({ fontSize: 64, lineHeight: 1.08 }, server.name),
        txt({ fontSize: 28, marginTop: 12, color: pal[3] }, subtitle),
      ]),
    ].filter(Boolean)),

    col({ gap: 26 }, [
      facts.length ? factRow(facts, pal[3]) : blank(),
      footer(pal[3]),
    ]),
  ]);
}
