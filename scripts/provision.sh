#!/usr/bin/env bash

set -uo pipefail

cd "$(dirname "$0")/.."

WR="npx --yes wrangler"
TOML=wrangler.toml
FAILED=0

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m  %s\n' "$*"; }
bad()  { printf '  \033[31mx\033[0m  %s\n' "$*"; FAILED=1; }

first_match() { grep -oE "$1" 2>/dev/null | head -1 || true; }

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN is not set." >&2
  echo "Create one at dash.cloudflare.com -> My Profile -> API Tokens." >&2
  exit 1
fi

say "Who am I?"
$WR whoami 2>&1 | grep -vE '^\s*$' | sed 's/^/  /'

say "D1 database"
OUT=$($WR d1 create wrapped 2>&1)
DB_ID=$(printf '%s' "$OUT" | first_match '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
if [ -z "$DB_ID" ]; then
  LIST=$($WR d1 list --json 2>&1)
  DB_ID=$(printf '%s' "$LIST" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(next((x.get('uuid','') for x in d if x.get('name')=='wrapped'),''))
except Exception:
    print('')" 2>/dev/null)
fi
if [ -n "$DB_ID" ]; then
  ok "database_id $DB_ID"
else
  bad "could not create or find the D1 database. wrangler said:"
  printf '%s\n' "$OUT" | sed 's/^/       /'
fi

say "KV namespace"
OUT=$($WR kv namespace create KV 2>&1)
KV_ID=$(printf '%s' "$OUT" | first_match '[0-9a-f]{32}')
if [ -z "$KV_ID" ]; then
  LIST=$($WR kv namespace list 2>&1)
  KV_ID=$(printf '%s' "$LIST" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(next((n.get('id','') for n in d if str(n.get('title','')).endswith('KV')),''))
except Exception:
    print('')" 2>/dev/null)
fi
if [ -n "$KV_ID" ]; then
  ok "kv id $KV_ID"
else
  bad "could not create or find the KV namespace. wrangler said:"
  printf '%s\n' "$OUT" | sed 's/^/       /'
fi

say "R2 bucket"
OUT=$($WR r2 bucket create wrapped-data 2>&1)
if printf '%s' "$OUT" | grep -qiE 'created|already (exists|taken)'; then
  ok "wrapped-data"
elif printf '%s' "$OUT" | grep -q '10042'; then
  bad "R2 is not enabled on this account yet"
  printf '       Go to dash.cloudflare.com -> R2 -> and enable it (needs a\n'
  printf '       payment method on file; nothing is charged under 10 GB).\n'
  printf '       Then re-run this script.\n'
  R2_NOT_ENABLED=1
else
  bad "R2 bucket failed. wrangler said:"
  printf '%s\n' "$OUT" | sed 's/^/       /'
fi

say "Queues"
for q in wrapped-builds wrapped-builds-dlq; do
  OUT=$($WR queues create "$q" 2>&1)
  if printf '%s' "$OUT" | grep -qiE 'created|already (exists|taken)'; then
    ok "$q"
  else
    bad "$q failed. wrangler said:"
    printf '%s\n' "$OUT" | sed 's/^/       /'
  fi
done

say "Updating $TOML"
python3 - "$TOML" "${DB_ID:-}" "${KV_ID:-}" <<'PY'
import re, sys
path, db, kv = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
if db:
    s = re.sub(r'database_id = "[^"]*"[^\n]*', f'database_id = "{db}"', s, count=1)
if kv:
    s = re.sub(r'(\[\[kv_namespaces\]\]\nbinding = "KV"\nid = )"[^"]*"[^\n]*',
               rf'\1"{kv}"', s, count=1)
open(path, 'w').write(s)
print(f'  database_id -> {db or "UNCHANGED"}')
print(f'  kv id       -> {kv or "UNCHANGED"}')
PY

if [ -n "$DB_ID" ]; then
  say "Applying schema"
  OUT=$($WR d1 execute wrapped --remote --file=./migrations/0001_init.sql 2>&1)
  if printf '%s' "$OUT" | grep -qiE 'executed|success'; then
    ok "schema applied"
  else
    bad "schema failed. wrangler said:"
    printf '%s\n' "$OUT" | tail -20 | sed 's/^/       /'
  fi
fi

if [ "$FAILED" = "1" ]; then
  say "Something did not complete"
  if [ "${R2_NOT_ENABLED:-0}" = "1" ]; then
    cat <<'EOF'
  R2 needs enabling once, by hand:

    dash.cloudflare.com -> R2 -> Enable

  It asks for a payment method, but the first 10 GB of storage and all egress
  are free, and this service stores ~7 MB per server.

  Everything else above succeeded. Re-run this script afterwards.
EOF
  else
    cat <<'EOF'
  If the error mentions authentication or permissions, check at
  dash.cloudflare.com/profile/api-tokens that the token has:

    Account · Workers Scripts      Edit
    Account · Workers KV Storage   Edit
    Account · Workers R2 Storage   Edit
    Account · D1                   Edit
    Account · Queues               Edit

  Fix it, then re-run - the script picks up where it left off.
EOF
  fi
  exit 1
fi

say "Remaining, by hand"
cat <<'EOF'
  1. Set DISCORD_CLIENT_ID in wrangler.toml, and add
     https://<your domain>/auth/callback as a redirect URI in the Discord portal.

  2. Secrets:
       npx wrangler secret put DISCORD_CLIENT_SECRET
       npx wrangler secret put METRICS_TOKEN
       npx wrangler secret put CF_ACCOUNT_ID          # optional, event metrics
       npx wrangler secret put CF_ANALYTICS_TOKEN     # optional, event metrics

  3. npx wrangler deploy

  4. Point your domain at the Worker (Workers Routes, or a custom domain).
EOF
