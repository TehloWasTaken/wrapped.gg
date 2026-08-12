import { BLOCK_BY_ID, ITEM_BY_ID, BLOCK_BY_NAME, ITEM_BY_NAME } from './legacy-ids.js';

const CATEGORIES = {
  mineBlock: ['mined', 'block'],
  craftItem: ['crafted', 'item'],
  useItem: ['used', 'item'],
  breakItem: ['broken', 'item'],
  pickup: ['picked_up', 'item'],
  drop: ['dropped', 'item'],
  killEntity: ['killed', 'entity'],
  entityKilledBy: ['killed_by', 'entity'],
};

const CUSTOM = new Map(Object.entries({
  playOneMinute: 'play_time',
  swimOneCm: 'walk_on_water_one_cm',
  diveOneCm: 'walk_under_water_one_cm',
  chestOpened: 'open_chest',
  enderchestOpened: 'open_enderchest',
  shulkerBoxOpened: 'open_shulker_box',
  trappedChestTriggered: 'trigger_trapped_chest',
  itemEnchanted: 'enchant_item',
  recordPlayed: 'play_record',
  noteblockPlayed: 'play_noteblock',
  noteblockTuned: 'tune_noteblock',
  flowerPotted: 'pot_flower',
  cakeSlicesEaten: 'eat_cake_slice',
  cauldronFilled: 'fill_cauldron',
  cauldronUsed: 'use_cauldron',
  armorCleaned: 'clean_armor',
  bannerCleaned: 'clean_banner',
  shulkerBoxCleaned: 'clean_shulker_box',
  workbenchInteraction: 'interact_with_crafting_table',
  craftingTableInteraction: 'interact_with_crafting_table',
  furnaceInteraction: 'interact_with_furnace',
  brewingstandInteraction: 'interact_with_brewingstand',
  beaconInteraction: 'interact_with_beacon',
  dispenserInspected: 'inspect_dispenser',
  dropperInspected: 'inspect_dropper',
  hopperInspected: 'inspect_hopper',
}));

const ENTITIES = new Map(Object.entries({
  Bat: 'bat', Blaze: 'blaze', CaveSpider: 'cave_spider', Chicken: 'chicken', Cow: 'cow',
  Creeper: 'creeper', Donkey: 'donkey', ElderGuardian: 'elder_guardian',
  EnderDragon: 'ender_dragon', Enderman: 'enderman', Endermite: 'endermite',
  EvocationFangs: 'evoker_fangs', EvocationIllager: 'evoker', EntityHorse: 'horse',
  Ghast: 'ghast', Giant: 'giant', Guardian: 'guardian', Husk: 'husk',
  IllusionIllager: 'illusioner', LavaSlime: 'magma_cube', Llama: 'llama', Mule: 'mule',
  MushroomCow: 'mooshroom', Ozelot: 'ocelot', Parrot: 'parrot', Pig: 'pig',
  PigZombie: 'zombified_piglin', PolarBear: 'polar_bear', Rabbit: 'rabbit', Sheep: 'sheep',
  Shulker: 'shulker', Silverfish: 'silverfish', Skeleton: 'skeleton',
  SkeletonHorse: 'skeleton_horse', Slime: 'slime', SnowMan: 'snow_golem', Spider: 'spider',
  Squid: 'squid', Stray: 'stray', Vex: 'vex', Villager: 'villager',
  VillagerGolem: 'iron_golem', VindicationIllager: 'vindicator', Witch: 'witch',
  WitherBoss: 'wither', WitherSkeleton: 'wither_skeleton', Wolf: 'wolf', Zombie: 'zombie',
  ZombieHorse: 'zombie_horse', ZombieVillager: 'zombie_villager',
}));

const snake = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const safe = (s) => s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');

function leafOf(rest, kind) {
  if (kind === 'entity') {
    return ENTITIES.get(rest) || safe(snake(rest)) || null;
  }
  const byId = kind === 'block' ? BLOCK_BY_ID : ITEM_BY_ID;
  if (/^-?\d+$/.test(rest)) {
    const id = Number(rest);
    return byId.get(id) || `${kind}_${Math.abs(id)}`;
  }
  const name = safe(rest.slice(rest.lastIndexOf('.') + 1));
  if (!name) return null;
  const byName = kind === 'block' ? BLOCK_BY_NAME : ITEM_BY_NAME;
  return byName.get(name) || name;
}

export function legacyKey(key) {
  if (!key.startsWith('stat.')) return null;
  const body = key.slice(5);
  const dot = body.indexOf('.');
  if (dot === -1) {
    const name = CUSTOM.get(body) || snake(body);
    return /^[a-z0-9_]+$/.test(name) ? `custom/${name}` : null;
  }
  const cat = CATEGORIES[body.slice(0, dot)];
  if (!cat) return null;
  const leaf = leafOf(body.slice(dot + 1), cat[1]);
  return leaf ? `${cat[0]}/${leaf}` : null;
}

export function normalizeKey(key, cache) {
  if (typeof key !== 'string' || key.indexOf('/') !== -1) return key;
  if (!cache) return legacyKey(key);
  let hit = cache.get(key);
  if (hit === undefined) {
    hit = legacyKey(key);
    cache.set(key, hit);
  }
  return hit;
}

export function looksLegacy(counters) {
  for (const k in counters) return k.indexOf('/') === -1;
  return false;
}

export function normalizeCounters(counters, cache) {
  const out = {};
  for (const k in counters) {
    const v = counters[k];
    if (typeof v !== 'number' || !isFinite(v) || v === 0) continue;
    const key = normalizeKey(k, cache);
    if (!key) continue;
    out[key] = (out[key] || 0) + v;
  }
  return out;
}
