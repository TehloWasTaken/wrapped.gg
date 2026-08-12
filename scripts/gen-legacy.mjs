import fs from 'node:fs';

const BASE = 'https://raw.githubusercontent.com/PrismarineJS/minecraft-data/master/data/pc';
const OUT = new URL('../src/build/legacy-ids.js', import.meta.url).pathname;

const get = async (path) => {
  const res = await fetch(`${BASE}/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
};

const clean = (s) => String(s).replace(/^minecraft:/, '').replace(/\[.*$/, '');

const legacy = await get('common/legacy.json');
const blocks112 = await get('1.12/blocks.json');
const items112 = await get('1.12/items.json');

const byId = (table) => {
  const out = new Map();
  for (const [k, v] of Object.entries(table)) {
    const [id, meta] = k.split(':');
    if (meta !== '0') continue;
    out.set(Number(id), clean(v));
  }
  return out;
};

const blockById = byId(legacy.blocks);
const itemById = byId(legacy.items);
for (const [id, name] of blockById) if (!itemById.has(id)) itemById.set(id, name);

const renames = (list, ids) => {
  const out = new Map();
  for (const entry of list) {
    const modern = ids.get(entry.id);
    if (modern && modern !== entry.name) out.set(entry.name, modern);
  }
  return out;
};

const blockNames = renames(blocks112, blockById);
const itemNames = renames(items112, itemById);

const numeric = (m) => [...m.entries()].sort((a, b) => a[0] - b[0])
  .map(([id, name]) => `[${id},'${name}']`).join(',');
const named = (m) => [...m.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1)
  .map(([old, name]) => `['${old}','${name}']`).join(',');

const wrap = (label, body) => `export const ${label} = new Map([\n${
  body.replace(/(.{1,96},)(?=\[)/g, '$1\n')}\n]);\n`;

fs.writeFileSync(OUT, [
  wrap('BLOCK_BY_ID', numeric(blockById)),
  wrap('ITEM_BY_ID', numeric(itemById)),
  wrap('BLOCK_BY_NAME', named(blockNames)),
  wrap('ITEM_BY_NAME', named(itemNames)),
].join('\n'));

console.log(`blocks by id   ${blockById.size}`);
console.log(`items by id    ${itemById.size}`);
console.log(`blocks renamed ${blockNames.size}`);
console.log(`items renamed  ${itemNames.size}`);
console.log(`${OUT}  ${(fs.statSync(OUT).size / 1024).toFixed(1)} KB`);
