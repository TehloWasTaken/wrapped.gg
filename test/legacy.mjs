import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { legacyKey, normalizeKey } from '../src/build/legacy.js';
import { buildWrapped } from '../src/build/build.js';

let fails = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '  ' + detail));
};
const eq = (label, got, want) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const UUID_A = '11111111-2222-3333-4444-555555555551';
const UUID_B = '11111111-2222-3333-4444-555555555552';
const UUID_C = '11111111-2222-3333-4444-555555555553';

const OLD_17 = {
  'stat.playOneMinute': 1440000,
  'stat.leaveGame': 30,
  'stat.deaths': 7,
  'stat.jump': 900,
  'stat.damageDealt': 15000,
  'stat.walkOneCm': 250000,
  'stat.mineBlock.1': 523,
  'stat.mineBlock.17': 64,
  'stat.mineBlock.8': 10,
  'stat.mineBlock.9': 5,
  'stat.craftItem.264': 2,
  'stat.useItem.278': 301,
  'stat.breakItem.278': 1,
  'stat.killEntity.Zombie': 42,
  'stat.entityKilledBy.Creeper': 3,
  'achievement.openInventory': 1,
};

const OLD_112 = {
  'stat.playOneMinute': 720000,
  'stat.mineBlock.minecraft.stone': 100,
  'stat.mineBlock.minecraft.log': 20,
  'stat.craftItem.minecraft.stone_pickaxe': 3,
  'stat.useItem.minecraft.dye': 9,
  'stat.pickup.minecraft.diamond': 11,
  'stat.killEntity.PigZombie': 5,
  'stat.killEntity.MushroomCow': 1,
  'stat.chestOpened': 12,
  'stat.sleepInBed': 4,
  'stat.swimOneCm': 1000,
  'stat.diveOneCm': 500,
  'stat.aviateOneCm': 2000,
  'stat.tradedWithVillager': 6,
  'stat.itemEnchanted': 2,
  'achievement.exploreAllBiomes': { value: 0, progress: ['Ocean'] },
};

const MODERN = {
  stats: {
    'minecraft:custom': {
      'minecraft:play_time': 360000,
      'minecraft:deaths': 2,
      'minecraft:jump': 100,
    },
    'minecraft:mined': { 'minecraft:stone': 40, 'minecraft:oak_log': 8 },
    'minecraft:killed': { 'minecraft:zombie': 3 },
  },
  DataVersion: 3465,
};

console.log('\nthe key translation');
eq('1.7 block ids become modern block names', legacyKey('stat.mineBlock.1'), 'mined/stone');
eq('numeric ids that gained a variant take the default one',
   legacyKey('stat.mineBlock.17'), 'mined/oak_log');
eq('item ids resolve against the item table', legacyKey('stat.craftItem.264'), 'crafted/diamond');
eq('used and broken are separate categories',
   legacyKey('stat.breakItem.278'), 'broken/diamond_pickaxe');
eq('1.8 to 1.12 names drop the namespace',
   legacyKey('stat.mineBlock.minecraft.stone'), 'mined/stone');
eq('and are carried through the flattening',
   legacyKey('stat.mineBlock.minecraft.log'), 'mined/oak_log');
eq('including items that were renamed', legacyKey('stat.useItem.minecraft.dye'), 'used/ink_sac');
eq('pickup is picked_up', legacyKey('stat.pickup.minecraft.diamond'), 'picked_up/diamond');
eq('drop is dropped', legacyKey('stat.drop.minecraft.diamond'), 'dropped/diamond');
eq('savegame entity names become current ids',
   legacyKey('stat.killEntity.PigZombie'), 'killed/zombified_piglin');
eq('deaths by an entity keep their own category',
   legacyKey('stat.entityKilledBy.Creeper'), 'killed_by/creeper');
eq('golems went through two renames',
   legacyKey('stat.killEntity.VillagerGolem'), 'killed/iron_golem');
eq('camel case general stats become snake case',
   legacyKey('stat.walkOneCm'), 'custom/walk_one_cm');
eq('play time is a rename, not a case change',
   legacyKey('stat.playOneMinute'), 'custom/play_time');
eq('old swimming was moving on the surface',
   legacyKey('stat.swimOneCm'), 'custom/walk_on_water_one_cm');
eq('and diving was moving under it',
   legacyKey('stat.diveOneCm'), 'custom/walk_under_water_one_cm');
eq('chests opened is spelled the other way round',
   legacyKey('stat.chestOpened'), 'custom/open_chest');
eq('a modded block keeps its own name', legacyKey('stat.mineBlock.tconstruct.ore'), 'mined/ore');
eq('a modded numeric id is kept as a number, not dropped',
   legacyKey('stat.mineBlock.4095'), 'mined/block_4095');
eq('achievements are not statistics', legacyKey('achievement.openInventory'), null);

console.log('\nwhat it refuses to touch');
eq('a modern key is returned unchanged', normalizeKey('mined/stone'), 'mined/stone');
eq('so is a modern custom key', normalizeKey('custom/play_time'), 'custom/play_time');
ok('a modern key never reaches the translator', legacyKey('mined/stone') === null);

console.log('\na build from old files');
const legacy = buildWrapped({
  v: 1, snapshot_at: 1,
  players: { [UUID_A]: { ...OLD_17 }, [UUID_B]: { ...OLD_112 } },
}, null, { collect: true });

const a = legacy.players.find(p => p.uuid === UUID_A);
const b = legacy.players.find(p => p.uuid === UUID_B);
eq('both players survive', legacy.players.length, 2);
eq('ticks are still ticks', a.playtime_hours, 20);
eq('deaths come across', a.deaths, 7);
eq('sessions come from leaveGame', a.sessions, 30);
eq('blocks mined sums every mined key', a.blocks_mined, 523 + 64 + 15);
eq('two ids that flattened into one block are added up',
   a.top_mined.find(r => r.id === 'water').count, 15);
eq('and appear once', a.top_mined.filter(r => r.id === 'water').length, 1);
eq('the top block is the one they dug most', a.top_mined[0].id, 'stone');
eq('mobs killed', a.mobs_killed, 42);
eq('what killed them', a.nemesis[0].id, 'creeper');
eq('distance is in the same centimetres', a.distance.walk, 2.5);
eq('an achievement is not a counter',
   a.top_mined.concat(a.top_used).some(r => r.id.startsWith('achievement')), false);

eq('1.12 names land in the same place', b.top_mined.find(r => r.id === 'oak_log').count, 20);
eq('chests opened', b.chests_opened, 12);
eq('nights slept', b.times_slept, 4);
eq('villager trades', b.trades, 6);
eq('items enchanted', b.enchants, 2);
eq('a zombie pigman is a zombified piglin now', b.top_killed[0].id, 'zombified_piglin');
ok('awards are earned on translated keys', b.awards.length > 0);

console.log('\nold and new in the same server');
const mixed = buildWrapped({
  v: 1, snapshot_at: 1,
  players: {
    [UUID_A]: { ...OLD_17 },
    [UUID_C]: { 'custom/play_time': 360000, 'custom/deaths': 2, 'custom/jump': 100,
                'mined/stone': 40, 'mined/oak_log': 8, 'killed/zombie': 3 },
  },
}, null, { collect: true });
const modern = mixed.players.find(p => p.uuid === UUID_C);
eq('a modern player is untouched by any of this', modern.playtime_hours, 5);
eq('and still ranks against the old one', modern.rank.playtime.rank, 2);
eq('the old player is first on playtime', mixed.server.leaderboards.playtime[0].uuid, UUID_A);
eq('the whole server total adds both', mixed.server.blocks_mined, 523 + 64 + 15 + 48);

console.log('\nthe modern path did not move');
const control = buildWrapped({
  v: 1, snapshot_at: 1,
  players: { [UUID_C]: { 'custom/play_time': 360000, 'custom/deaths': 2, 'custom/jump': 100,
                         'mined/stone': 40, 'mined/oak_log': 8, 'killed/zombie': 3 } },
}, null, { collect: true });
eq('same numbers on its own', control.players[0].blocks_mined, 48);
eq('same playtime', control.players[0].playtime_hours, 5);

console.log('\nthe shell client reads both shapes');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wgg-legacy-'));
fs.mkdirSync(path.join(dir, 'stats'));
fs.writeFileSync(path.join(dir, 'stats', `${UUID_A}.json`), JSON.stringify(OLD_17));
fs.writeFileSync(path.join(dir, 'stats', `${UUID_C}.json`), JSON.stringify(MODERN));
fs.writeFileSync(path.join(dir, 'stats', 'Notch.json'), JSON.stringify(OLD_17));

const shell = fs.readFileSync(new URL('../web/assets/upload.sh', import.meta.url), 'utf8');
const py = /python3 - "\$TMP" <<'PY'\n([\s\S]*?)\nPY\n/.exec(shell);
ok('the reader is still a python heredoc in upload.sh', !!py);
const pyPath = path.join(dir, 'reader.py');
fs.writeFileSync(pyPath, py[1]);
const outPath = path.join(dir, 'out.ndjson.gz');
const run = spawnSync('python3', [pyPath, outPath], {
  env: { ...process.env, WORLD: dir, USERCACHE: '', WTTY: '0', WBLOCK: '0',
         WSOURCE: 'test', WQUIET: '0' },
  encoding: 'utf8',
});
eq('the reader exits clean', run.status, 0);
const { gunzipSync } = await import('node:zlib');
const rows = gunzipSync(fs.readFileSync(outPath)).toString().trim().split('\n').map(JSON.parse);
eq('it writes a header and two players', rows.length, 3);
const shellOld = rows.find(r => r.u === UUID_A);
const shellNew = rows.find(r => r.u === UUID_C);
eq('old keys are sent through as they were found', shellOld.c['stat.mineBlock.1'], 523);
eq('achievements are left behind', shellOld.c['achievement.openInventory'], undefined);
eq('modern files are still flattened client side', shellNew.c['mined/stone'], 40);
ok('a file named after a player is skipped, loudly',
   /named after a player/.test(run.stderr), run.stderr.trim());

console.log('\nthe browser client agrees');
const js = fs.readFileSync(new URL('../web/assets/uploader.js', import.meta.url), 'utf8');
const fn = /const strip = [^\n]*\n[\s\S]*?\nfunction countersOf\(doc\) \{[\s\S]*?\n\}\n/.exec(js);
ok('countersOf is still in uploader.js', !!fn);
const countersOf = new Function(`${fn[0]}; return countersOf;`)();
const browserOld = countersOf(OLD_17);
const browserNew = countersOf(MODERN);
eq('the browser sends the same old keys', browserOld['stat.mineBlock.1'], 523);
eq('it drops achievements too', browserOld['achievement.openInventory'], undefined);
eq('an achievement object is not mistaken for a counter',
   countersOf(OLD_112)['achievement.exploreAllBiomes'], undefined);
eq('and it flattens modern files the same way', browserNew['mined/stone'], 40);
eq('both clients produce identical rows for the old file',
   JSON.stringify(browserOld), JSON.stringify(shellOld.c));
eq('and for the modern file', JSON.stringify(browserNew), JSON.stringify(shellNew.c));

fs.rmSync(dir, { recursive: true, force: true });

console.log(fails ? `\n${fails} failed\n` : '\nall good\n');
process.exit(fails ? 1 : 0);
