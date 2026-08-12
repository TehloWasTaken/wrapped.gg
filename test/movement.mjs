import fs from 'node:fs';
import { buildWrapped, RANK_METRIC_KEYS } from '../src/build/build.js';
import { ranksHeader, ranksLine, readRanks } from '../src/build/ranks.js';

const STATS = process.argv[2] || process.env.WRAPPED_STATS_DIR || 'world/stats';

let fails = 0;
const ok = (label, cond, detail = '') => {
  if (!cond) fails++;
  console.log((cond ? '  ok   ' : '  FAIL ') + label + (cond || !detail ? '' : '  ' + detail));
};
const eq = (label, got, want) =>
  ok(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const strip = (s) => (s.startsWith('minecraft:') ? s.slice(10) : s);

function loadCanonical(dir) {
  const players = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let raw;
    try { raw = JSON.parse(fs.readFileSync(dir + '/' + f, 'utf8')); } catch { continue; }
    const d = {};
    for (const [cat, e] of Object.entries(raw.stats || {})) {
      const c = strip(cat);
      for (const [k, v] of Object.entries(e)) if (v) d[`${c}/${strip(k)}`] = v;
    }
    if (Object.keys(d).length) players[f.slice(0, -5)] = d;
  }
  return { v: 1, snapshot_at: Math.floor(Date.now() / 1000), players };
}

if (!fs.existsSync(STATS)) {
  console.log(`skipped: no stats folder at ${STATS}`);
  process.exit(0);
}
const payload = loadCanonical(STATS);
console.log(`loaded ${Object.keys(payload.players).length.toLocaleString()} players from ${STATS}`);

const AT_1 = Math.floor(Date.now() / 1000) - 7 * 86400;
const lines = [ranksHeader(AT_1) + '\n'];
const first = buildWrapped(payload, null, {
  collect: true,
  onRanks: (uuid, vec) => lines.push(ranksLine(uuid, vec)),
});
console.log(`build 1: ${first.players.length.toLocaleString()} players`);

console.log('\nthe sidecar');
eq('one line per player, plus a header', lines.length, first.players.length + 1);
const parsed = await readRanks(new Blob(lines).stream());
ok('round-trips', !!parsed);
eq('carries the build time', parsed.at, AT_1);
eq('holds every player', parsed.ranks.size, first.players.length);

const byName = new Map(first.players.filter(p => p.name).map(p => [p.name, p]));
const board1 = first.server.leaderboards.playtime;
eq('a leaderboard to move on', board1.length, 10);
ok('nothing to compare against on a first build', first.players.every(p => p.movement === null));
ok('and no arrows on its leaderboards', board1.every(r => r.moved === undefined));

const vec = parsed.ranks.get(board1[0].uuid);
eq('rank 1 is stored as 1', vec[RANK_METRIC_KEYS.indexOf('playtime')], 1);

const wrong = ['{"v":1,"metrics":["mined","playtime"],"at":1}\n', ranksLine('x', [1, 2])];
eq('a mismatched metric list is refused', await readRanks(new Blob(wrong).stream()), null);
const future = ['{"v":99,"metrics":' + JSON.stringify(RANK_METRIC_KEYS) + '}\n'];
eq('a version from the future is refused', await readRanks(new Blob(future).stream()), null);

const CLIMBER = board1[4].uuid, LEADER = board1[0].uuid;

const next = loadCanonical(STATS);
next.players[CLIMBER] = {
  ...next.players[CLIMBER],
  'custom/play_time': (next.players[LEADER]['custom/play_time'] || 0) + 20,
};
const lines2 = [ranksHeader(AT_1 + 86400) + '\n'];
const second = buildWrapped(next, null, {
  collect: true,
  previous: { at: AT_1, ranks: parsed.ranks },
  onRanks: (uuid, vec) => lines2.push(ranksLine(uuid, vec)),
});
const now2 = new Map(second.players.map(p => [p.uuid, p]));

console.log('\nwhat moved');
const climber = now2.get(CLIMBER);
eq('the climber is first now', climber.rank.playtime.rank, 1);
eq('was fifth', climber.rank.playtime.was, 5);
eq('so it passed four people', climber.rank.playtime.moved, 4);
eq('and that is its headline', climber.movement.best.moved, 4);
eq('named by metric', climber.movement.best.key, 'playtime');
eq('places gained, totalled', climber.movement.climbed, 4);
eq('and the window it happened in', climber.movement.since, AT_1);

const leader = now2.get(LEADER);
eq('the old leader is second', leader.rank.playtime.rank, 2);
eq('having dropped one', leader.rank.playtime.moved, -1);
eq('which is a fall, not a climb', leader.movement.climbed, 0);
eq('counted as one place lost', leader.movement.fell, 1);

console.log('\nwho is left alone');
const moved = second.players.filter(p => p.movement && p.movement.moves.length);
eq('exactly five players moved', moved.length, 5);
eq('and they are the top five', moved.map(p => p.uuid).sort().join(),
   board1.slice(0, 5).map(r => r.uuid).sort().join());
ok('nobody else carries a movement block',
   second.players.every(p => p.movement === null || p.movement.moves.length > 0));
const pi = RANK_METRIC_KEYS.indexOf('playtime');
ok('and every other rank reports moved: 0 rather than nothing',
   second.players.filter(p => !moved.includes(p) && p.rank.playtime && parsed.ranks.has(p.uuid))
     .every(p => p.rank.playtime.moved === 0 &&
                 p.rank.playtime.was === parsed.ranks.get(p.uuid)[pi]));

const NEWCOMER = 'ffffffff-0000-4000-8000-000000000001';
const third = loadCanonical(STATS);
third.players[NEWCOMER] = { 'custom/play_time': 72000, 'mined/stone': 500 };
const ranks2 = await readRanks(new Blob(lines2).stream());
const built3 = buildWrapped(third, null, { collect: true, previous: { at: AT_1 + 86400, ranks: ranks2.ranks } });

console.log('\nsomebody new');
const rookie = built3.players.find(p => p.uuid === NEWCOMER);
ok('is in the build', !!rookie);
eq('and has nothing to be compared against', rookie.movement, null);
ok('so no rank claims it moved',
   Object.values(rookie.rank).every(r => !r || r.moved === undefined));
ok('while the people it pushed down are told they were pushed down',
   built3.players.some(p => p.rank.playtime && p.rank.playtime.moved === -1));

console.log('\nthe server boards');
const board2 = second.server.leaderboards.playtime;
eq('report the same window', second.server.movement_since, AT_1);
eq('the climber leads them', board2[0].uuid, CLIMBER);
eq('having come from fifth', board2[0].was, 5);
eq('by four places', board2[0].moved, 4);
eq('and the old leader shows the drop', board2[1].moved, -1);

console.log('\ndeaths are ranked most-first, so climbing them is not a promotion');
const deathMetric = (await import('../src/build/build.js')).RANK_METRICS
  .find(m => m.key === 'deaths');
eq('the build says so', deathMetric.good, false);

console.log('\n' + (fails ? `FAILED (${fails})` : 'rank movement ok'));
process.exit(fails ? 1 : 0);
