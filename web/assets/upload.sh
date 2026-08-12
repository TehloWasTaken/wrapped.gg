#!/bin/sh
set -eu

ENDPOINT="https://wrapped.gg/v1/snapshots"
KEY="${WRAPPED_KEY:-}"
WORLD=""
SOURCE="shell"
DRY=0
ICON=1
QUIET=0

if [ -t 2 ] && [ -z "${NO_COLOR:-}" ]; then
  B=$(printf   '\033[1m')
  DIM=$(printf '\033[2m')
  GRN=$(printf '\033[92m')
  DGRN=$(printf '\033[32m')
  GLD=$(printf '\033[93m')
  CYA=$(printf '\033[96m')
  YEL=$(printf '\033[33m')
  RED=$(printf '\033[91m')
  R=$(printf   '\033[0m')
  TTY=1
else
  B=""; DIM=""; GRN=""; DGRN=""; GLD=""; CYA=""; YEL=""; RED=""; R=""; TTY=0
fi

case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
  *UTF-8*|*UTF8*|*utf-8*|*utf8*) BLOCK=1 ;;
  *) BLOCK=0 ;;
esac

SEP=$(printf '\037')

say()  { [ "$QUIET" = 1 ] || printf '%s\n' "$*" >&2; }
step() { [ "$QUIET" = 1 ] || printf '\n%s[%s/4]%s %s%s%s\n' "$GRN$B" "$1" "$R" "$B" "$2" "$R" >&2; }
info() { [ "$QUIET" = 1 ] || printf '      %s%-10s%s %s\n' "$DIM" "$1" "$R" "$2" >&2; }
path() { [ "$QUIET" = 1 ] || printf '      %s%-10s%s %s%s%s\n' "$DIM" "$1" "$R" "$CYA" "$2" "$R" >&2; }
good() { [ "$QUIET" = 1 ] || printf '      %s%-10s%s %s%s%s\n' "$DIM" "$1" "$R" "$GRN" "$2" "$R" >&2; }
warn() { printf '      %s!%s %s%s%s\n' "$YEL$B" "$R" "$YEL" "$*" "$R" >&2; }
oops() { printf '\n  %serror:%s %s\n' "$RED$B" "$R" "$*" >&2; }
rule() { [ "$QUIET" = 1 ] || printf '%s  --------------------------------------------------%s\n' "$DIM" "$R" >&2; }

banner() {
  [ "$QUIET" = 1 ] && return 0
  printf '\n  %swrapped%s%s.gg%s  %suploader%s\n' "$B" "$R" "$GRN$B" "$R" "$DIM" "$R" >&2
  rule
}

usage() {
  cat >&2 <<'EOF'

usage: sh -s -- --key <api key> [options]

  --key       the wgg_live_... key from https://wrapped.gg/panel. Or put it in
              WRAPPED_KEY, which keeps it out of the process list
  --world     the folder holding stats/, if it is not found on its own
  --source    tag these uploads, e.g. the name of your panel. hosting
              providers: see https://wrapped.gg/hosts
  --quiet     warnings and errors only, for cron
  --no-icon   do not send server-icon.png
  --dry-run   read everything, send nothing

usercache.json and server-icon.png are found on their own. The icon is only
used if you have not already set one in the panel.
EOF
  exit 2
}

noval() { banner; oops "$1 needs a value"; usage; }

while [ $# -gt 0 ]; do
  case "$1" in
    --key)      [ $# -ge 2 ] || noval "$1"; KEY="$2"; shift 2 ;;
    --world)    [ $# -ge 2 ] || noval "$1"; WORLD="$2"; shift 2 ;;
    --endpoint) [ $# -ge 2 ] || noval "$1"; ENDPOINT="$2"; shift 2 ;;
    --source)   [ $# -ge 2 ] || noval "$1"
                SOURCE=$(printf '%s' "$2" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9-' '-' | cut -c1-24)
                shift 2 ;;
    --quiet|-q) QUIET=1; shift ;;
    --dry-run)  DRY=1; shift ;;
    --no-icon)  ICON=0; shift ;;
    -h|--help)  banner; usage ;;
    *) banner; oops "unknown option: $1"; usage ;;
  esac
done

[ -n "$SOURCE" ] || SOURCE="shell"

banner
SITE="${ENDPOINT%%/v1/*}"

if [ -z "$KEY" ]; then
  oops "--key is required."
  say  "       Get one from $SITE/panel, then run:"
  say  "       curl -sL $SITE/u | sh -s -- --key wgg_live_yourkeyhere"
  exit 2
fi
case "$KEY" in
  wgg_live_*) ;;
  *) oops "that is not a wrapped.gg key. They start with wgg_live_."
     exit 2 ;;
esac
case "$KEY" in
  *[!A-Za-z0-9_-]*)
     oops "that key has characters a key cannot contain. Copy it again."
     exit 2 ;;
esac
if [ ${#KEY} -lt 20 ] || [ ${#KEY} -gt 128 ]; then
  oops "that key is the wrong length, so it was probably cut short on the way in."
  exit 2
fi

command -v python3 >/dev/null 2>&1 || { oops "python3 is required but not installed."; exit 1; }
command -v curl    >/dev/null 2>&1 || { oops "curl is required but not installed."; exit 1; }

step 1 "Looking for your server files"

if [ -z "$WORLD" ]; then
  LEVEL=""
  [ -f ./server.properties ] &&
    LEVEL=$(sed -n 's/^[[:space:]]*level-name[[:space:]]*=[[:space:]]*//p' ./server.properties |
            head -n1 | tr -d '\r')

  [ -n "$LEVEL" ] && LEVELP="$LEVEL/players" || LEVELP=""
  for c in . "$LEVEL" "$LEVELP" ./world ./world/players \
           /home/container/world /home/container/world/players \
           /data/world /data/world/players \
           ./server/world ./server/world/players ./minecraft/world; do
    [ -n "$c" ] && [ -d "$c/stats" ] && { WORLD="$c"; break; }
  done

  if [ -z "$WORLD" ]; then
    for c in ./*/ ./*/*/; do
      [ -d "$c/stats" ] && { WORLD="${c%/}"; break; }
    done
  fi

  if [ -z "$WORLD" ] && command -v find >/dev/null 2>&1; then
    FOUND=$(find . -maxdepth 4 -type d -name stats 2>/dev/null | head -n1)
    [ -n "$FOUND" ] && WORLD="${FOUND%/stats}"
  fi
fi

if [ -z "$WORLD" ] || [ ! -d "$WORLD/stats" ]; then
  oops "could not find a stats/ folder from here."
  say  "       You are in: $(pwd)"
  say  ""
  say  "       Run this from your server folder, your world folder, or wherever"
  say  "       stats/ lives. That is world/stats, or world/players/stats on"
  say  "       Minecraft 26.x and newer."
  say  "       Or point at it:  --world /path/to/folder/holding/stats"
  exit 1
fi
path "stats" "$WORLD/stats"

findup() {
  for _c in "./$1" "$WORLD/$1" "$WORLD/../$1" "$WORLD/../../$1" "$WORLD/../../../$1" \
            "../$1" "../../$1" "../../../$1"; do
    [ -f "$_c" ] && { printf '%s' "$_c"; return 0; }
  done
  return 1
}

USERCACHE=$(findup usercache.json) || USERCACHE=""
if [ -n "$USERCACHE" ]; then
  path "names" "$USERCACHE"
else
  warn "no usercache.json found"
  say  "        Everyone will show as a row of letters and numbers and nobody"
  say  "        will be able to look themselves up. It sits next to"
  say  "        server.properties, so try running this from there."
fi

ICONFILE=""
if [ "$ICON" = 1 ]; then
  ICONFILE=$(findup server-icon.png) || ICONFILE=""
  if [ -n "$ICONFILE" ]; then
    path "icon" "$ICONFILE"
  else
    info "icon" "none found, the default grass block will be used"
  fi
fi

TMP=$(mktemp -t wrapped.XXXXXX)
RESP=$(mktemp -t wrapped.XXXXXX)
AUTH=$(mktemp -t wrapped.XXXXXX)
trap 'rm -f "$TMP" "$RESP" "$AUTH"' EXIT
trap 'printf "\n\n  %sstopped.%s An accepted upload keeps building without this window, and re-running is always safe.\n\n" "$YEL$B" "$R" >&2; exit 130' INT

printf 'header = "Authorization: Bearer %s"\n' "$KEY" > "$AUTH"

jread() {
  _f="$1"; shift
  python3 -c 'import json, sys
sep = "\x1f"
try:
    with open(sys.argv[1], encoding="utf-8") as fh:
        d = json.load(fh)
except Exception:
    d = {}
if not isinstance(d, dict):
    d = {}
out = []
for k in sys.argv[2:]:
    v = d.get(k)
    out.append("" if v is None or v is False else str(v).replace(sep, " ").replace("\n", " "))
print(sep.join(out))' "$_f" "$@" 2>/dev/null || printf '\n'
}

step 2 "Reading player stats"

IDEM=$(WORLD="$WORLD" USERCACHE="$USERCACHE" WTTY="$TTY" WBLOCK="$BLOCK" \
       WSOURCE="$SOURCE" WQUIET="$QUIET" python3 - "$TMP" <<'PY'
import glob, gzip, hashlib, json, os, re, sys, time

out_path = sys.argv[1]
world = os.environ['WORLD']
usercache = os.environ.get('USERCACHE') or ''
tty = os.environ.get('WTTY') == '1'
block = os.environ.get('WBLOCK') == '1'
quiet = os.environ.get('WQUIET') == '1'
source = os.environ.get('WSOURCE') or 'shell'

if tty:
    B, DIM, GRN, DGRN, GLD, YEL, R = (
        '\033[1m', '\033[2m', '\033[92m', '\033[32m', '\033[93m', '\033[33m', '\033[0m')
else:
    B = DIM = GRN = DGRN = GLD = YEL = R = ''

UUID = re.compile(r'[0-9a-fA-F-]{16,48}\Z')


def num(n):
    return f'{GLD}{n:,}{R}'


def line(msg):
    if not quiet:
        print('      ' + msg, file=sys.stderr)


def strip(s):
    return s[10:] if s.startswith('minecraft:') else s


def counters_of(doc):
    out = {}
    stats = doc.get('stats')
    if isinstance(stats, dict):
        for cat, entries in stats.items():
            c = strip(cat)
            for k, v in entries.items():
                if v:
                    out[f'{c}/{strip(k)}'] = v
        return out
    for k, v in doc.items():
        if not k.startswith('stat.'):
            continue
        if isinstance(v, dict):
            v = v.get('value')
        if isinstance(v, bool) or not isinstance(v, (int, float)) or not v:
            continue
        out[k] = v
    return out


names = {}
by_name = {}
if usercache:
    try:
        with open(usercache, encoding='utf-8') as fh:
            for e in json.load(fh):
                if e.get('uuid') and e.get('name'):
                    names[e['uuid']] = e['name']
                    by_name[e['name'].lower()] = e['uuid']
        line(f'{num(len(names))} player names loaded')
    except Exception as ex:
        line(f'{YEL}! usercache.json could not be read ({ex}){R}')

files = sorted(glob.glob(os.path.join(world, 'stats', '*.json')))
if not files:
    print(f'      {YEL}! stats/ contained no player files{R}', file=sys.stderr)
    sys.exit(1)

total = len(files)
line(f'{num(total)} files to read')

start = time.time()


def progress(done):
    if not tty or quiet:
        return
    frac = done / total
    filled = int(frac * 28)
    elapsed = time.time() - start
    eta = (elapsed / frac - elapsed) if frac > 0.02 else 0
    eta_s = f'  {DIM}about {int(eta) + 1}s left{R}' if eta >= 1 else ''
    on, off = ('\u2588', '\u2591') if block else ('#', '.')
    sys.stderr.write('\r      %s%s%s%s%s%s %s%3d%%%s  %s of %s%s ' % (
        GRN, on * filled, R, DGRN + DIM, off * (28 - filled), R,
        B, int(frac * 100), R,
        num(done), f'{DIM}{total:,}{R}', eta_s))
    sys.stderr.flush()


raw_bytes = 0
n = 0
unmatched = 0
every = max(1, total // 100)
digest = hashlib.sha256()
with open(out_path, 'wb') as fp, \
        gzip.GzipFile(filename='', mode='wb', fileobj=fp, compresslevel=6, mtime=0) as gz:
    gz.write((json.dumps({'v': 1, 'snapshot_at': int(time.time()), 'source': source},
                         separators=(',', ':')) + '\n').encode())
    for i, f in enumerate(files):
        if i % every == 0:
            progress(i)
        base = os.path.basename(f)[:-5]
        uuid = base if UUID.match(base) else by_name.get(base.lower(), '')
        if not uuid:
            unmatched += 1
            continue
        try:
            with open(f, 'rb') as fh:
                data = fh.read()
            doc = json.loads(data)
        except Exception:
            continue
        raw_bytes += len(data)
        counters = counters_of(doc) if isinstance(doc, dict) else {}
        if not counters:
            continue
        row = {'u': uuid, 'c': counters}
        if uuid in names:
            row['n'] = names[uuid]
        payload = (json.dumps(row, separators=(',', ':')) + '\n').encode()
        digest.update(payload)
        gz.write(payload)
        n += 1

progress(total)
if tty and not quiet:
    sys.stderr.write('\r' + ' ' * 78 + '\r')
    sys.stderr.flush()


def size(b):
    return f'{b/1048576:.1f} MB' if b >= 1048576 else f'{max(1, round(b/1024)):,} KB'


line(f'{num(n)} players with something to show')
line(f'{GLD}{size(os.path.getsize(out_path))}{R} to send  {DIM}(read {size(raw_bytes)} from disk){R}')
if unmatched:
    print(f'      {YEL}! {unmatched:,} files are named after a player instead of a UUID, '
          f'which is Minecraft 1.7.5 and older. Pages are keyed on the account UUID and '
          f'only usercache.json maps a name to one, so those were skipped.{R}',
          file=sys.stderr)
if n == 0:
    print(f'      {YEL}! none of those files had any counters in them{R}', file=sys.stderr)
    sys.exit(1)

print(digest.hexdigest())
PY
)

SIZE=$(wc -c < "$TMP")

if [ "$DRY" = 1 ]; then
  step 3 "Dry run, stopping here"
  info "would send" "$SIZE bytes to $ENDPOINT"
  [ -n "$ICONFILE" ] && info "would send" "$ICONFILE"
  say ""
  exit 0
fi

step 3 "Uploading"

[ "$TTY" = 1 ] && PROGRESS="--progress-bar" || PROGRESS="-s"

HTTP=$(curl $PROGRESS -K "$AUTH" --retry 3 --retry-delay 2 --retry-connrefused \
     --connect-timeout 20 --speed-limit 1024 --speed-time 60 \
     -X POST "$ENDPOINT" \
     -H "Content-Type: application/x-ndjson" \
     -H "Expect:" \
     -H "Idempotency-Key: $IDEM" \
     -H "X-Wrapped-Source: $SOURCE" \
     --data-binary "@$TMP" -o "$RESP" -w '%{http_code}') || HTTP=000

IFS="$SEP" read -r SNAP SLUG DUPE REQUEUED APIMSG <<EOF
$(jread "$RESP" snapshot_id slug duplicate requeued message)
EOF

apimsg() { [ -z "$APIMSG" ] || printf '        %s\n' "$APIMSG" >&2; }

case "$HTTP" in
  2*) ;;
  000)
    oops "could not reach $SITE."
    say  "        Check this machine's connection and run the command again."
    say  "        Nothing was uploaded, so nothing is half done."
    exit 1 ;;
  401|403)
    oops "that key was not accepted."
    apimsg
    say  "        Copy it again from $SITE/panel. A revoked key stops working"
    say  "        immediately, and a fresh one is free to make."
    exit 1 ;;
  413)
    oops "that upload is too large."
    apimsg
    say  "        Something other than the stats folder was picked up."
    exit 1 ;;
  429)
    oops "too many uploads today."
    apimsg
    say  "        This is an annual product. Try again tomorrow."
    exit 1 ;;
  5*)
    oops "wrapped.gg had a problem on its side (HTTP $HTTP)."
    apimsg
    say  "        Nothing is wrong with your files. Run the same command again"
    say  "        in a minute; re-uploading identical data is free."
    exit 1 ;;
  *)
    oops "the upload was refused (HTTP $HTTP)."
    apimsg
    say  "        Run it again. If it keeps happening, go on the message above."
    exit 1 ;;
esac

if [ -n "$REQUEUED" ]; then
  info "note" "same data as before, rebuilding it"
elif [ -n "$DUPE" ]; then
  info "note" "identical to your last upload, so nothing changed"
else
  good "sent" "$(((SIZE + 1023) / 1024)) KB accepted"
fi

step 4 "Building your Wrapped"

STATE="queued"; PLAYERS=""; BUILDERR=""
WAITED=0; LAST=""; SAME=0; NETFAIL=0; STALLED=0
LIMIT=600

if [ -z "$SNAP" ]; then
  warn "no snapshot id came back, so the build cannot be followed"
  say  "        Check $SITE/panel in a minute to see whether it finished."
else
  say "      this usually takes a few seconds"
  STATUS_URL="$SITE/v1/snapshots/$SNAP"
  while [ "$WAITED" -lt "$LIMIT" ]; do
    sleep 2
    WAITED=$((WAITED + 2))

    if ! curl -fsS -K "$AUTH" --connect-timeout 10 --max-time 15 "$STATUS_URL" \
              -o "$RESP" 2>/dev/null; then
      NETFAIL=$((NETFAIL + 1))
      if [ "$NETFAIL" = 6 ]; then
        say ""
        warn "cannot reach $SITE to check on it. Still trying."
        say  "        Your upload was accepted, so the build carries on regardless."
      fi
      continue
    fi
    NETFAIL=0

    IFS="$SEP" read -r STATE PLAYERS BUILDERR <<EOF
$(jread "$RESP" state players error)
EOF

    if [ "$STATE" = "$LAST" ]; then SAME=$((SAME + 2)); else SAME=0; LAST="$STATE"; fi

    if [ "$TTY" = 1 ]; then
      case "$STATE" in
        queued)   WORD="waiting for a build slot" ;;
        building) WORD="crunching your stats" ;;
        *)        WORD="$STATE" ;;
      esac
      printf '\r      %s%-26s%s %s%ss elapsed%s    ' "$DIM" "$WORD" "$R" "$DIM" "$WAITED" "$R" >&2
    fi

    if [ "$SAME" -ge 120 ] && [ "$STALLED" = 0 ]; then
      STALLED=1
      [ "$TTY" = 1 ] && printf '\r%-60s\r' " " >&2
      warn "still \"$STATE\" after ${WAITED}s, longer than this should take."
      say  "        Ctrl+C and run the same command again to restart the build,"
      say  "        or leave it; it will notice when it finishes."
    fi

    case "$STATE" in ready|failed) break ;; esac
  done
  [ "$TTY" = 1 ] && printf '\r%-60s\r' " " >&2
fi

if [ "$STATE" = "failed" ]; then
  oops "the build failed: $BUILDERR"
  say  "        Running the same command again is safe and usually fixes it."
  exit 1
fi

if [ "$STATE" != "ready" ]; then
  oops "gave up watching after ${WAITED}s. The build is still \"$STATE\"."
  say  ""
  say  "        Your upload was accepted, so it is not lost."
  say  "          1. Check $SITE/panel; it may have finished on its own."
  say  "          2. If it still says building in a few minutes, run the same"
  say  "             command again. That restarts the build."
  exit 1
fi

if [ -n "$ICONFILE" ]; then
  ICON_SIZE=$(wc -c < "$ICONFILE")
  if [ "$ICON_SIZE" -gt 524288 ]; then
    warn "$ICONFILE is over 512 KB, skipping it"
  elif curl -fsS -K "$AUTH" --connect-timeout 10 --max-time 60 -X POST "$SITE/v1/logo" \
        -H "Content-Type: image/png" \
        --data-binary "@$ICONFILE" -o "$RESP" 2>/dev/null; then
    if grep -q '"skipped"' "$RESP" 2>/dev/null; then
      info "icon" "you already have one set in the panel, kept that"
    else
      good "icon" "sent"
    fi
  else
    warn "the server icon was not accepted. Everything else worked."
  fi
fi

say ""
rule
if [ "$QUIET" = 1 ]; then
  :
elif [ -n "$PLAYERS" ] && [ "$PLAYERS" != 0 ]; then
  printf '  %s%s players%s are in it.\n\n' "$GRN$B" "$PLAYERS" "$R" >&2
else
  printf '  %sBuilt.%s\n\n' "$GRN$B" "$R" >&2
fi
[ -n "$SLUG" ] && path "your link" "$SITE/$SLUG"
info "next step" "open the panel and press Publish to make it public"
info "" "$SITE/panel"
say ""
