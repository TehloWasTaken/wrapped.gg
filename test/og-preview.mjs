#!/usr/bin/env node

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import satori from 'satori';
import { Resvg, initWasm } from '@resvg/resvg-wasm';
import { W, H, PALETTES, playerTemplate, serverTemplate } from '../src/og/template.js';
import { worldAge } from '../src/lib/birthday.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test/out');

const SERVER = { name: 'Example SMP', slug: 'example-k7m2p', players: 3244, palette: 3 };
const SUMMARY = { playtime_hours: 173249, blocks_mined: 112900000 };
const PLAYER = {
  name: 'Notch', uuid: 'x', playtime_hours: 3704, blocks_mined: 1284551, mobs_killed: 5732266,
  distance: { total_km: 6902 },
  signature_award: { title: 'Dedication', rank: 1, of: 3244 },
};

async function main() {
  await initWasm(await readFile(join(ROOT, 'node_modules/@resvg/resvg-wasm/index_bg.wasm')));
  const font = await readFile(join(ROOT, 'web/assets/font/Minecraftia-Regular.ttf'));
  const logo = `data:image/png;base64,${(await readFile(join(ROOT, 'web/icon-512.png'))).toString('base64')}`;
  const fallback = `data:image/png;base64,${(await readFile(join(ROOT, 'web/assets/default-icon.png'))).toString('base64')}`;
  await mkdir(OUT, { recursive: true });

  const draw = async (name, tree) => {
    const svg = await satori(tree, {
      width: W, height: H, fonts: [{ name: 'Pixel', data: font, weight: 400, style: 'normal' }],
    });
    const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } }).render().asPng();
    await writeFile(join(OUT, name), png);
    console.log(`${name.padEnd(26)} ${(png.length / 1024).toFixed(1)} KB`);
  };

  const pal = PALETTES[SERVER.palette];
  await draw('og-server.png', serverTemplate({ server: SERVER, summary: SUMMARY, pal, logo }));
  await draw('og-server-default.png', serverTemplate({ server: SERVER, summary: SUMMARY, pal, logo: fallback }));
  await draw('og-server-nologo.png', serverTemplate({ server: SERVER, summary: SUMMARY, pal, logo: null }));
  const today = new Date();
  const born = Date.UTC(today.getUTCFullYear() - 4, today.getUTCMonth(), today.getUTCDate()) / 1000;
  await draw('og-server-birthday.png',
             serverTemplate({ server: SERVER, summary: SUMMARY, pal, logo, birthday: worldAge(born) }));

  await draw('og-player.png', playerTemplate({ player: PLAYER, server: SERVER, pal, logo }));
  await draw('og-player-sparse.png', playerTemplate({
    player: { name: 'FreshSpawn', playtime_hours: 0.4 }, server: SERVER, pal, logo: null,
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
