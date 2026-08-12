#!/usr/bin/env node

import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import satori from 'satori';
import { Resvg, initWasm } from '@resvg/resvg-wasm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');

const C = {
  bg:      '#14141a',
  panel:   '#262630',
  inset:   '#101015',
  bevelHi: '#43434f',
  bevelLo: '#0c0c10',
  text:    '#eeeef4',
  muted:   '#adadba',
  dim:     '#77778a',
  green:   '#3ecf72',
  greenHi: '#5ded8f',
  greenLo: '#1c8b48',
  onGreen: '#05240f',
  gold:    '#ffc93c',
};

const el = (style, children) => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } });
const col = (style, children) => el({ flexDirection: 'column', ...style }, children);
const txt = (style, children) => el(style, String(children));

const feature = (title, detail) => el({ gap: 13, alignItems: 'flex-start' }, [
  el({ width: 14, height: 14, marginTop: 7, background: C.green }, ''),
  col({}, [
    txt({ fontSize: 21, color: C.text }, title),
    txt({ fontSize: 17, color: C.dim, marginTop: 8 }, detail),
  ]),
]);

function ogTemplate() {
  return col(
    { width: '100%', height: '100%', position: 'relative',
      background: `linear-gradient(122deg, #16281e 0%, #15191c 46%, ${C.bg} 74%, #101015 100%)`,
      fontFamily: 'Pixel', color: C.text, padding: '54px 60px',
      justifyContent: 'space-between' },
    [
      el({ alignItems: 'center', gap: 14 }, [
        txt({ fontSize: 32, color: C.text }, 'wrapped'),
        txt({ fontSize: 32, color: C.greenHi }, '.gg'),
        txt({ fontSize: 20, color: C.dim, marginLeft: 16, marginTop: 8 },
            'FREE · ANY MINECRAFT SERVER · NO PLUGIN'),
      ]),

      col({}, [
        txt({ fontSize: 72, lineHeight: 1.12 }, "Your server's year,"),
        txt({ fontSize: 72, lineHeight: 1.12, color: C.greenHi }, 'wrapped.'),
        txt({ fontSize: 26, color: C.muted, marginTop: 22 },
            'Every player gets their own year in review, from stats your server already keeps.'),
      ]),

      col({ gap: 26 }, [
        el({ gap: 40 }, [
          feature('Upload once', 'one stats folder'),
          feature('No plugin, no mod', 'works on any host'),
          feature('Every player', 'gets their own page'),
        ]),
        el({ alignItems: 'center', justifyContent: 'space-between', width: '100%',
             borderTopWidth: 2, borderTopStyle: 'solid',
             borderTopColor: 'rgba(255,255,255,0.12)', paddingTop: 20 }, [
          txt({ fontSize: 21, color: C.dim }, 'Set it up in about five minutes'),
          txt({ fontSize: 21, color: C.greenHi }, 'wrapped.gg'),
        ]),
      ]),
    ],
  );
}

const W_ART = [
  '................',
  '................',
  '..##........##..',
  '..##........##..',
  '..##........##..',
  '..##........##..',
  '..##........##..',
  '..##...##...##..',
  '..##...##...##..',
  '..##...##...##..',
  '..##...##...##..',
  '..############..',
  '..############..',
  '................',
  '................',
  '................',
];

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

function encodePng(width, height, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function iconPng(size) {
  const art = W_ART, N = art.length;
  const bg = hex(C.green), fg = hex(C.onGreen);
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const sy = Math.min(N - 1, Math.floor(y * N / size));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(N - 1, Math.floor(x * N / size));
      const c = art[sy][sx] === '#' ? fg : bg;
      const i = (y * size + x) * 4;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  return encodePng(size, size, rgba);
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...images.map(i => Buffer.from(i.png))]);
}

const OG_PAGES = ['index.html', 'docs.html', 'hosts.html'];
const OG_URL = /(https:\/\/wrapped\.gg\/og\.png)(\?v=[A-Za-z0-9]+)?/g;

async function stampOgVersion(png) {
  const v = createHash('sha256').update(png).digest('hex').slice(0, 8);
  for (const page of OG_PAGES) {
    const path = join(WEB, page);
    const before = await readFile(path, 'utf8');
    const after = before.replace(OG_URL, `$1?v=${v}`);
    if (after !== before) await writeFile(path, after);
    console.log(`${page.padEnd(22)} og:image v=${v}${after === before ? ' (unchanged)' : ''}`);
  }
  return v;
}

async function render(tree, width, height, font) {
  const svg = await satori(tree, {
    width, height, fonts: [{ name: 'Pixel', data: font, weight: 400, style: 'normal' }],
  });
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
}

async function main() {
  await initWasm(await readFile(join(ROOT, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')));
  const font = await readFile(join(WEB, 'assets/font/Minecraftia-Regular.ttf'));

  const ico16 = iconPng(16), ico32 = iconPng(32);
  const og = await render(ogTemplate(), 1200, 630, font);

  const out = [
    ['og.png', og],
    ['apple-touch-icon.png', iconPng(180)],
    ['icon-192.png', iconPng(192)],
    ['icon-512.png', iconPng(512)],
    ['favicon.png', ico32],
    ['favicon-16.png', ico16],
    ['favicon.ico', buildIco([{ size: 16, png: ico16 }, { size: 32, png: ico32 }])],
  ];

  for (const [name, bytes] of out) {
    await writeFile(join(WEB, name), bytes);
    console.log(`${name.padEnd(22)} ${(bytes.length / 1024).toFixed(1)} KB`);
  }
  await stampOgVersion(og);
}

main().catch((e) => { console.error(e); process.exit(1); });
