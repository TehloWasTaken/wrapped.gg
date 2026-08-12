#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOOLS = new Set(['local', 'rotate']);
const opts = {}, positional = [];
for (const argv = process.argv.slice(2), it = argv.entries(); ;) {
  const step = it.next();
  if (step.done) break;
  const [i, a] = step.value;
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const k = a.slice(2);
  if (BOOLS.has(k)) opts[k] = true;
  else { opts[k] = argv[i + 1]; it.next(); }
}
const flag = (name, fallback = null) => opts[name] ?? fallback;
const has = (name) => opts[name] === true;

const [name, slug] = positional;
if (!name || !slug) {
  console.error(`
usage: node scripts/add-partner.mjs "<name>" <slug> [options]

  --contact   email or Discord handle, so we can reach them
  --website   their site
  --max       server limit (default 10000)
  --rotate    the partner already exists; replace their token
  --local     run against the local D1 instead of production
`);
  process.exit(2);
}
if (!/^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/.test(slug)) {
  console.error('slug must be 3 - 24 lowercase letters, numbers and dashes');
  process.exit(2);
}

const ulid = () =>
  Date.now().toString(36).padStart(9, '0') +
  [...randomBytes(10)].map(b => b.toString(36).padStart(2, '0')).join('').slice(0, 16);

const token = 'wgg_host_' + randomBytes(24).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const t = Math.floor(Date.now() / 1000);

const sql = has('rotate')
  ? `UPDATE partners SET token_hash = ${q(hash)}, prefix = ${q(token.slice(0, 16))},
       revoked_at = NULL WHERE slug = ${q(slug)};`
  : `
INSERT INTO users (id, discord_id, username, avatar, created_at, last_login_at)
VALUES (${q(ulid())}, ${q('partner:' + slug)}, ${q(name + ' (partner)')}, NULL, ${t}, ${t});

INSERT INTO partners (id, name, slug, contact, website, token_hash, prefix,
                      user_id, max_servers, created_at)
SELECT ${q(ulid())}, ${q(name)}, ${q(slug)}, ${q(flag('contact', ''))},
       ${q(flag('website', ''))}, ${q(hash)}, ${q(token.slice(0, 16))},
       id, ${Number(flag('max', 10000)) || 10000}, ${t}
  FROM users WHERE discord_id = ${q('partner:' + slug)};`;

const file = join(tmpdir(), `partner-${slug}-${Date.now()}.sql`);
writeFileSync(file, sql);
try {
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'wrapped',
    has('local') ? '--local' : '--remote', '--file', file, '--yes'],
    { stdio: 'inherit' });
} finally {
  unlinkSync(file);
}

console.log(`
  partner : ${name}  (${slug})
  token   : ${token}

  Shown once - it is stored as a hash. Send it over something private, and
  point them at https://wrapped.gg/hosts

  Check it:
    curl https://wrapped.gg/v1/host/ping -H "Authorization: Bearer ${token}"
`);
