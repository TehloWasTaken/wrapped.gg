# wrapped.gg

A year-in-review for any Minecraft server. Owners upload the `stats/` folder
their server already writes; every player gets a page and a shareable card.

There is no plugin and no mod. Nothing runs alongside the game, which is why it
behaves the same on €3 shared hosting as on a dedicated box, and why the server
can be Vanilla, Paper, Fabric, Forge or anything else.

Runs entirely on Cloudflare: Workers, D1, R2, Queues and Analytics Engine.

This is the source for the service running at
[wrapped.gg](https://wrapped.gg). It is published because hosting companies
integrating `/v1/host` into their panels asked to see what happens to their
customers' data before they send any, which is a fair thing to ask. Everything
the hosted service runs is here apart from the operator portal, which is
support tooling for one person and is kept private.

You can also just run it. It is a single Worker with a handful of bindings, and
`scripts/provision.sh` creates all of them.

---

## How it works

```
  server owner                 wrapped.gg
  ────────────                 ──────────
  world/stats/*.json  ──┐      (world/players/stats on MC 26.X+)
  usercache.json      ──┴──▶  flatten in the client
                              (61 MB folder → 8 MB upload)
                                     │  gzipped NDJSON
                                     ▼
                              POST /v1/snapshots ──▶ R2 (raw snapshot)
                                     │
                                     ▼ queue
                              build: columnar store, 216 ranked awards
                                     │
                                     ├─▶ R2   build/<id>/players.ndjson  (packed)
                                     ├─▶ R2   build/<id>/ranks.ndjson    (for the next build)
                                     └─▶ D1   name → uuid + byte offset
                                     │
                                     ▼
                        /<slug>/<player>  =  1 indexed lookup + 1 range read
```

### Three decisions that shaped everything

The wire format is NDJSON rather than one JSON document. A single
`{"players": {...}}` has to be parsed in full before you can touch any of it,
and for a 3,244-player server that parsed object comes to about 133 MB. A Worker
gets 128 MB in total. Line-oriented input lets the build fold one player in and
then drop it, so peak memory is whatever the columnar store weighs (~19 MB) no
matter how big the server is. Without this the whole thing needs a container.

Counters are stored columnar: keys interned to integers once, values in typed
arrays, players as offsets into them (CSR). Object-per-player measured 133 MB
for the same data against 19 MB here. Both figures came off a real build.

Builds write one packed file instead of one object per player. A Worker
invocation is capped at around 1000 subrequests and a binding call counts
towards it, so 3,244 R2 writes would die partway through. D1 records each
player's byte range inside a single file instead. A page view is then one
indexed lookup and a ~4 KB range read, and the build does two writes.

### Names, and our own usercache

The stats folder contains UUIDs and nothing else. `usercache.json` is what turns
those into names, and a large share of uploads arrive without it, because it
lives in a different folder from the one people were told to zip.

For those, names come from a Mojang mirror. That is the only part of a page view
which depends on somebody else's rate limit, so lookups go through three tiers
and the last one is genuinely a last resort:

| Tier | Where | Expiry |
|---|---|---|
| 1 | KV | 30 days |
| 2 | `usercache` in D1 | never |
| 3 | playerdb, then ashcon | — |

Tier 2 is the one that matters. KV on its own never accumulates: a name bought
this month is dropped next month and bought again, so the API bill stays flat
forever. Put a durable table behind it and a UUID is resolved at most once,
after which KV expiry falls back to a D1 read instead of an HTTP request.

The cache is shared across tenants, because a UUID is the same person
everywhere. A name learned on one server answers a lookup on another, so servers
that upload a `usercache.json` quietly pay down the bill for the ones that
forget.

Filling happens on the read path and never during a build. A page that already
knows a name, because it came with the snapshot, files that one pair through
`rememberNames`. KV is the guard: an `mcname:` entry means this UUID is already
on file, so the second view of the same page writes nothing. A 3,000-player
upload where forty pages ever get opened used to cost 3,000 rows and ~200
statements on the queue consumer, most of them for names nobody asked for. Now
it costs what people actually look at.

The guard fires only on an *empty* KV entry, never on a different one. A name
that came back from a live lookup outranks a name from somebody's snapshot,
which can be a season out of date, so filing never overwrites it.

Only positive results are stored. A "no such account" is cached briefly in KV
and nowhere else: names get released and re-registered, and a permanent record
of "this does not exist" is a permanent wrong answer waiting to happen.

The `name_lookup` metric carries the tier that answered. Watch the share
reaching `mojang`; it should fall as snapshots land.

### Where the stats folder is

Two layouts, both live in the wild:

| Minecraft | Path |
|---|---|
| 26.X and newer | `world/players/stats/<uuid>.json` |
| 25.X and older | `world/stats/<uuid>.json` |

Nothing asks which version a server runs. The shell client and the browser
uploader both go looking for the folder, checking `players/` first and falling
back. Anything reading stats off a disk has to handle both, so a new ingest path
should follow the same order.

### Servers still on old versions

Minecraft has written that file three different ways, and all three still turn
up in uploads:

| Minecraft | one counter, as stored |
|---|---|
| 1.13 and newer | `{"stats":{"minecraft:mined":{"minecraft:stone":523}},"DataVersion":3465}` |
| 1.8 – 1.12 | `{"stat.mineBlock.minecraft.stone":523}` |
| 1.7.x | `{"stat.mineBlock.1":523}` |

1.13 nested and namespaced the whole thing. Before that a stats file was one
flat map of dotted keys, and before 1.8 blocks and items were numeric ids (`1`
is stone), because resource names did not exist yet. Entities never caught up at
all and stayed savegame names like `PigZombie` right through 1.12.

The clients only decide which of the two shapes they are holding. A document
with a `stats` object is flattened to `mined/stone` as it always was; anything
else has its `stat.` keys copied out untouched, with achievements dropped since
they are not counters. The translation happens once, in the build
(`src/build/legacy.js`), so the awards, the ranks and everything downstream see
exactly one vocabulary. Keeping it in the build rather than the clients also
means a mistake in the tables can be fixed later and picked up by a rebuild,
without anyone being asked to upload again. The shell client stays a script that
reads files and posts them.

`CounterStore.addPlayer` is the choke point. A key with no `/` in it is a legacy
key, and every path into the store goes through that one method: a build, a
baseline, the subtraction. Modern keys cost an `indexOf` and come back
untouched.

`src/build/legacy-ids.js` is generated by `npm run gen:legacy` from
PrismarineJS/minecraft-data: numeric id → modern name for blocks and items, plus
the pre-flattening names that changed (`log` → `oak_log`, `dye` → `ink_sac`).
Old stats carry no block metadata, so an id that later split into variants lands
on the default one. All 1.7 wool is white wool, and there is no way back from
what was recorded. An id missing from the table is modded; it is kept as
`block_4095` instead of being dropped, so "blocks mined" stays true even where
the label cannot be.

General statistics are mostly a case change (`stat.walkOneCm` → `walk_one_cm`),
so `legacy.js` lists only the couple of dozen Mojang actually renamed. The
famous one is `stat.playOneMinute` → `play_time`. The trap is `stat.swimOneCm`,
which became `walk_on_water_one_cm`; the modern `swim_one_cm` counts
sprint-swimming, which nothing before 1.13 could do.

One thing this does not fix. 1.7.5 and older named the file after the player
(`Notch.json`), and UUID filenames only arrive in 1.7.6. Every page, row, rank
and head here is keyed on the UUID, and `usercache.json`, the one file that maps
a name to one, did not exist yet either. Those files get matched through
`usercache.json` when a server has one, and are skipped with a sentence saying
why when it does not.

### Why there are no advancements

They are 98% recipe-unlock noise: 6,003,511 entries against 112,278 real ones on
the reference server, in a 948 MB folder that then has to be moved. Everything
you would derive from them (join dates, rarity) belongs to a different product
from "what did you actually do". Counters only.

---

## Setup

```bash
npm install
cp wrangler.toml.example wrangler.toml

export CLOUDFLARE_API_TOKEN=...      # this IS the auth; do not run `wrangler login`
export CLOUDFLARE_ACCOUNT_ID=...
./scripts/provision.sh               # creates D1, KV, R2, queues; applies schema
                                     # then paste the two ids it prints into wrangler.toml
npm run db:remote:partners           # migration 0002: the hosting-provider tables
npm run db:remote:admin              # migration 0003: partner pause, audit log
npm run db:remote:usercache          # migration 0004: our own uuid -> name cache
npm run db:remote:birthday           # migration 0005: the world's creation date
npm run db:remote:blocked            # migration 0006: per-server blocklist

npx wrangler secret put DISCORD_CLIENT_SECRET
npx wrangler secret put METRICS_TOKEN        # what VictoriaMetrics scrapes with
npx wrangler secret put CF_ANALYTICS_TOKEN   # optional: enables event metrics
npx wrangler secret put CF_ACCOUNT_ID        # optional: same

npx wrangler deploy
```

`wrangler login` and `CLOUDFLARE_API_TOKEN` are alternatives, not steps. With the
token set, wrangler refuses to run `login`. That error means you are already
authenticated and should skip straight to provisioning.

The token needs these permissions:

| Scope | Permission |
|---|---|
| Account · Workers Scripts | Edit |
| Account · Workers KV Storage | Edit |
| Account · Workers R2 Storage | Edit |
| Account · D1 | Edit |
| Account · Queues | Edit |
| Account · Account Analytics | Read *(only for `/metrics` event counters)* |

The "Edit Cloudflare Workers" template does **not** include D1 or Queues. Add
those two by hand or provisioning fails partway through.

`wrangler.toml` is gitignored, since it holds your own resource ids. Copy
`wrangler.toml.example` over it, put your `DISCORD_CLIENT_ID` and `SITE_URL` in,
and add `<your domain>/auth/callback` as a redirect URI in the Discord developer
portal.

Discord is the only identity this service has, and the only one it wants.
Nothing here talks to Microsoft, Mojang authentication or Xbox Live: the one
external service a page view can depend on is a Mojang *name* mirror, which is
read-only, unauthenticated, and cached down towards zero by the usercache above.

### Local development

`workerd` needs GLIBC 2.32+. On older hosts, run it in a container:

```bash
docker run --rm -it --network host -v "$PWD:/app" -w /app node:22-bookworm \
  sh -c "npm i && npx wrangler dev --local --ip 0.0.0.0 --port 8788"
```

Put local secrets in `.dev.vars`, which is gitignored along with
`wrangler.toml`.

---

## Layout

```
src/
  index.js            router; tenant pages get server-rendered meta tags
  auth/discord.js     OAuth; no passwords, no stored access tokens
  api/ingest.js       streams uploads to R2, never parses on the request path
  api/servers.js      owner CRUD; keys stored as hashes only; slugs and logos
  api/partners.js     the hosting-provider API and the claim flow
  api/public.js       name → uuid → range read (handles Bedrock name prefixes)
  api/heads.js        player heads, fetched once then cached forever
  api/metrics.js      private Prometheus endpoint
  lib/birthday.js     how old a world is, and whether today is its birthday
  build/columnar.js   the memory model
  build/ndjson.js     the wire format
  build/build.js      ranking + per-player documents
  build/ranks.js      the rank sidecar, so the next build can say what moved
  build/consumer.js   queue worker
  og/template.js      the two unfurl layouts, as plain data
  og/card.js          renders them lazily; caches to R2 forever
web/                  landing, docs, hosts, panel, uploader, player experience
  assets/wrapped.js   the story, for a player and for the server itself
  assets/card.js      the two downloadable cards, drawn on a canvas in the tab
  assets/upload.sh    shell uploader, served at /u (POSIX sh + python3)
  hosts.html          the partner API, documented for hosting providers
scripts/gen-og.mjs    regenerates og.png and the app icons
scripts/add-partner.mjs  issues a partner token from the command line
test/og-preview.mjs   renders every share card to test/out/ so they can be seen
test/movement.mjs     builds a real server twice and checks what it says moved
test/birthday-sql.py  the birthday column and the previous-build lookup
```

## Public URLs

A slug is `<name>-<5 random chars>`, so `wrapped.gg/survival-k7m2p`. The suffix
earns its place twice over:

- these are other people's stats, and the obvious name is guessable. A server
  that has not shared its link should not turn up by typing what it is called.
- two servers can both be called "survival" and both get the URL they wanted.

The alphabet excludes `0 1 i l o`, so a slug read off a screenshot is
unambiguous. Slugs created before this existed keep working; nothing is
rewritten.

Owners can upload a logo (`POST /v1/servers/:id/logo`; the panel squares it to
256×256 in the browser first, so the server only ever stores something small).
It shows on their own page and is composited into every share image, so a link
posted in a Discord carries their identity rather than ours. Each upload gets a
fresh R2 key, and that key is part of the OG cache key: a changed logo has to
produce a changed image URL.

### The one number on the landing page

The hero says how many players already have their Wrapped, then tells you yours
are one upload away, with the button immediately underneath. The count is there
to do the persuading, so it is built as part of the call to action instead of as
a statistic sitting near one. The card and the buttons share a wrapper, the
wrapper is sized by the button row, and the card is `width: 0; min-width: 100%`
so its own text can never widen that row. They line up at every width because
they are one block.

It is the only figure the service publishes about itself, and it is the same one
anything internal reports as "players across live builds": `SUM(players)` over
live builds. No names, no server count, nothing that says whose players they are.
`test/served.mjs` renders the page and asserts it differs from the asset on disk
in exactly one place, so a second figure cannot be slipped in here quietly.

It is server-rendered into `<!--SERVED-->` rather than fetched, the same way
`metaTags` is stamped into `wrapped.html`. The number is the reason to keep
reading, and one that arrives after the buttons are already drawn is worth less
than none. That means `/` has to reach the Worker, which is why it is listed in
`run_worker_first`; without that the asset server answers first and the
placeholder ships raw to the browser. The count is cached in KV for an hour,
since it only moves when somebody uploads, and a D1 scan on every visit to the
busiest page buys very little. If the cache or the query fails, the line is
simply absent. A landing page that 500s because a boast would not load is a
worse trade.

Below 500 it is left out. "42 players already have their Wrapped" argues against
using the service, and a threshold is more honest than rounding up.

One trap if you touch the card: **do not baseline-align Minecraftia with
Rubik.** At 26px Minecraftia's ink sits 40px above the baseline where Rubik's
15.5px sits 12px above, so inline layout puts them on visibly different lines.
Centring the two boxes on each other lands the ink within a pixel; the
`translateY(-1px)` on the number is that pixel, taken from `measureText`. The
same metrics are why the card wants more padding at the top than the bottom,
since the digits start flush with the top of their own box.

## On somebody else's website

Plenty of servers already have a site, and sending their players off it to look
themselves up is a worse deal than it sounds. `/embed/<slug>` is the same tenant
page with a flag set: same shell, same `wrapped.js`, same story, same cards. Two
lines put it on their own page:

```html
<div data-wrapped="survival-k7m2p"></div>
<script src="https://wrapped.gg/embed.js" async></script>
```

It is an iframe rather than a widget rendering into their DOM, which is the
whole reason it stays maintainable. Their CSS cannot reach our Minecraftia, our
reset cannot reach their layout, and there is one implementation of the story to
keep working. `embed.js` creates the frame and listens; it is under 4 KB and
renders nothing itself.

The frame and the page talk over `postMessage`, three messages, all one way:
`ready` carries the height of the search panel so the box fits its content
without the owner guessing a number, `open` says a story has started, `close`
says it ended. On `open` the loader takes the frame full screen, because a story
told in a 600px box is not worth reading. Closing puts the visitor back exactly
where they were, and the loader pushes one history entry so the phone's back
button does the same. **The full-screen height has to be set inline.** The
loader writes the fitted height as an inline style, so a class will not win
against it later.

Everything degrades on purpose. Without the script a bare `<iframe>` still works
and the docs give that version for site builders that strip `<script>`; it only
loses the sizing and the full-screen step. `data-expand="off"` keeps a story in
the box for people who want that, and `data-player` opens one player's year
directly.

Headers are the part to be careful with. The embed answers
`content-security-policy: frame-ancestors *`, so any site may frame a published
Wrapped. That includes the 404, which means a wrong slug shows our sentence
instead of the browser's refusal. The app pages went the other way at the same
time: `/panel`, `/upload`, `/docs` and `/hosts` answer `x-frame-options: DENY`,
which none of them did before. The embed is `noindex` with no `og:` tags on it
at all, because the page that should be indexed and unfurled is `/<slug>`. The
"made with ♥ on wrapped.gg" line links there in a new tab.

Views through an embed are still views. `trackPageView` gained a fourth blob,
the surface (`site` or `embed`), so the panel can show owners what their own
site is bringing in without that traffic being counted as anything other than
what it is.

## Setup, as a flow

The panel is a four-step wizard rather than a form with a manual next to it:
name and icon → how you want to send stats → send them → publish. The key is
created during step one and held in memory for the rest of the flow, so on the
browser path nobody is ever asked to copy a key. On the shell path it is printed
inside a command that already runs.

`web/assets/uploader.js` is that step as a component, mounted inside the wizard
and again on `/upload` for people coming back later. One implementation means
the flow that matters most is the one that gets fixed when something is wrong.
Its failures are named: "no player stats in that file, you probably zipped the
wrong folder, here is where it is" beats an error code.

### The server's own page, in five tabs

Everything after setup happens on one screen, and that screen kept growing: twelve
sections stacked in a column, every one of them rendered the moment you opened a
server. It is now five tabs (Overview, Your page, Traffic, Embed, Uploads) with
the Discord card sitting below them on every one, because needing help is not a
section anybody should have to go and find.

Two things fall out of the split. The Analytics Engine query and the live embed
iframe are the expensive things on that screen and both now wait until their tab
is opened, so a visit that only re-uploads stats pays for neither. The tab also
lives in the URL as `/panel#/<slug>/traffic`, so a reload comes back where you
were, you can send somebody a link to the thing you are talking about, and the
back button leaves the server rather than walking backwards through tabs. Tab
switches use `replaceState`; opening a server pushes.

The strip is one bevelled panel with the tabs as segments inside it, and the
selected one is pressed *in*: dark inset, emerald label, emerald bar along its
bottom edge. That is how a Minecraft GUI shows a chosen thing, and it follows the
rule the buttons here already do, which is that nothing lifts off the page. The
labels are Rubik rather than Minecraftia, and that is the one place the type rule
bends. Minecraftia is for headings and numbers, it goes muddy at the 14px a tab
label wants, and these are buttons, so they take the button's type. `.rail` in
the wizard already did the same.

The strip sticks under the header while you scroll, on desktop only. On a phone the
header already wraps to two rows, and a second pinned bar under it costs more screen
than it gives back.

A gold dot on the Uploads tab means the newest upload failed. Tabs hide things, and
a build that did not finish is the one thing an owner must not have to go looking
for.

The `live` / `private` badge beside the server name is the Minecraftia trap
again, wearing a second disguise. On the share card, centring the two boxes on
each other lands the ink within a pixel. Here it does not. An `h1` has
`line-height: 1.3` and Minecraftia's ink sits in the *top* of that box: at 34px
a capital `H` spans from 52px to 23px above the baseline, so the baseline is
nowhere near the bottom of the letters and the centre of the box is well below
the middle of them. `align-items: center` therefore hangs the badge visibly low.
The fix is a `translateY` sized per breakpoint, −7px at the 28px `h1` and −8.5px
at 34px, which is a flat 0.25 of the font size and puts the badge on the centre
of the cap band. To measure it rather than eyeball it: drop a zero-height
inline-block into the heading to find the true baseline, scan a canvas render of
`H` for its ink rows, centre on that. Do not switch the units to `em`, which on
the badge resolves against the badge's own 12px.

The shell client finds the world itself, reading `level-name` out of
`server.properties`, so the command is:

```
curl -sL https://wrapped.gg/u | sh -s -- --key wgg_live_xxx
```

Run from the server's folder, with nothing to fill in but the key. It rejects
anything not starting `wgg_live_`. The placeholder used to be `<your key>`, which
is shell redirection syntax and fails in a thoroughly confusing way when pasted
as-is.

## Hosting providers

`/v1/host` is a second front door, for companies putting this inside their own
panel. One partner token (`wgg_host_…`), many customer servers, and no Discord
login in the middle:

```
POST /v1/host/servers  { name, external_id }  →  slug + wgg_live_ upload key
POST /v1/snapshots     with that key          →  the ordinary ingest path
GET  /v1/host/servers/ext:<their id>          →  state of the last build
```

Three decisions carry it.

`external_id` is required and create is idempotent on it. A panel already has an
id for the server, and making that the idempotency key means a retried request
returns the same Wrapped instead of a second one. It also lets a host address
every endpoint as `ext:<their id>` without ever persisting an id of ours.

Unclaimed servers are owned by a synthetic user, one per partner.
`servers.owner_id` is NOT NULL and points at a real account, so instead of
widening the schema each partner gets a user row that holds its customers'
servers. `/claim/<token>` moves ownership to whichever Discord account opens the
link.

Once a server is claimed the partner may push snapshots and do nothing else.
Renames, publishing and deletion all return `409 claimed`. A host administering
a page is fine; a host deleting a page their customer has taken over is not.

Partners are onboarded by hand, with `node scripts/add-partner.mjs "Name" slug`,
because somebody is about to send us other people's stats at scale and we would
like to know who they are. `web/hosts.html` is the documentation they get.

## Two stories

`/<slug>/<player>` is one player's year. `/<slug>#server` is the whole server's:
the same format and mechanics, with leaderboards instead of personal ranks. It
is built entirely from the summary document every build already writes, so it
costs one fetch and no extra storage.

A player story runs to at most twenty cards and only ever shows a card backed by
a real number. Padding with empty screens is worse than being short. Jokes come
from pools seeded on the player's uuid, so two people with similar stats read
differently and one person sees the same lines on a rewatch.

## Rank movement

Every build writes down where each player stood: `build/<id>/ranks.ndjson`, nine
metrics per player, stored positionally. The next build reads it and the
difference becomes `movement` on the player document, so a card can say **you
passed four people** instead of *you are eighth*. Leaderboards carry the same
arrows.

Four things shape it.

It is a file rather than more columns. The obvious place is D1, carried forward
on `players`, except that `players` is deleted and rewritten in full on every
build. Carrying anything forward would mean reading every row back out first:
thousands of rows through the query path to produce something one caller reads
once, in bulk. As a file it is one R2 write out and one R2 read in, the same
shape as the packed player file sitting beside it. It also gets deleted along
with its build, so a pruned build cannot leave a stale rank pointing at something
nobody can open.

The metric list is the format, and the file says so. Ranks are stored
positionally against `RANK_METRICS`, so reordering that array would silently
reinterpret every stored row as a different metric. The header carries the key
list and the reader rejects a file whose list disagrees. A bad diff is worse than
no diff, because it puts a confident wrong number on a card.

A changed baseline disqualifies the comparison. An owner who nominates a baseline
has changed the question from "all of time" to "since March", and every rank in
the previous file answers the old one. The consumer checks for this and skips.
Same for a server past `MAX_TRACKED_PLAYERS`: the Wrapped matters more than the
arrows on it, so the arrows are what get dropped.

A snapshot is never compared against itself. The previous ranks come from the
newest build whose `latest_id` is not the snapshot being built, rather than from
the live one. Blocking a player rebuilds the same upload, and without that rule
the build would diff a snapshot against itself and report the removal as
movement.

Up is not always good. The deaths board is ranked most-first like every other
one, so `RANK_METRICS` marks it and the arrow direction and the colour part
company.

## Blocked players

Banned accounts, alts, a staff character with 4,000 hours of creative-mode
playtime sitting on top of every board - most servers have somebody they would
rather their Wrapped did not mention. `blocked_players` is a row per player per
server, and the panel's "Your page" tab searches the current build by name so a
uuid never has to be typed.

**The block happens during the build rather than on the way out.** Blocked uuids
are dropped as the snapshot is folded, in `buildFromStream`, before anything gets
counted. A blocked player is therefore absent rather than hidden: off every
leaderboard, out of the server totals, out of the ranking that decides everyone
else's position, with no page and no share card. Filtering on read would have
produced a board of nine rows with a hole at four, and totals that still counted
them.

**That means a rebuild, so blocking triggers one.** The live build's snapshot
goes back on the queue and the page is correct within about a minute; a
3,269-player rebuild is 2.5 seconds of CPU. Telling somebody to upload again is
the wrong answer for the one setting they reach for while a griefer is sitting on
their front page. Having nothing to rebuild yet is not an error either: the row
is stored, the first build honours it, and the panel says which of the two
happened.

**The lookup path enforces it as well.** `findPlayer` carries a `NOT EXISTS`
against `blocked_players`, so the player page, the OG card and the search box all
stop answering the moment the row is written, without waiting on the build or
depending on it having succeeded. It stays one indexed statement.

Identity is the uuid, because names change and a ban usually is a name change.
The name is copied onto the row for display - after the rebuild that player is
gone from `players`, so a join would have nothing left to read. Blocking is
capped at 200 per server, uuids match in either spelling and either case
(`dashless` on both sides), and unblocking rebuilds the same way. Blocking every
player in a snapshot fails the build, saying so.

## The world's birthday

`servers.world_born_at`, nominated by the owner. Nothing in a stats folder knows
it. `world/stats/*.json` is written the first time somebody earns a counter, and
`level.dat`, the only file carrying a creation time, is not part of the upload
and is not worth making part of it. So the date is set by hand or it stays null,
and every birthday surface is simply absent. Guessing would put a confident wrong
number on a page whose whole point is being exact.

Everything derived from it is computed **per request** and never baked into a
build. A world's age changes every day and its anniversary arrives whether or not
anybody has uploaded lately, so anything read off a build would be stale by
however long it has been since the last upload.

The window is seven days rather than one. Servers upload on their own schedule
and plenty upload weekly, and a one-day window is a birthday that a weekly cron
misses six times out of seven.

Inside the window the server's share image changes what it leads with, and gets a
different URL for it. Share images are served `immutable` for a year and Discord
caches unfurls on top of that, so a card whose content changes while its URL does
not is a card nobody who already posted the link will ever see. `metaTags`
appends `?b=<n>`, and `handleOg` recomputes the occasion from the database
without ever reading that parameter.

## The look

Minecraft's own GUI: flat panels with a 3px hard bevel, no rounded corners and
Minecraftia for anything that reads as a label. The one accent is emerald,
because it is the brightest friendly thing in the game and the colour players
associate with being rewarded; gold carries the numbers.

Three things sit on top of that, and they hang together:

- **One large emerald glow, fixed to the viewport.** It does not scroll, so
  content moves across a light that stays put.
- **Panels are glass over it.** `--glass` fills plus a backdrop blur, gated on
  `@supports (backdrop-filter)`. A browser without it gets the flat panels and
  loses nothing, since the bevel stays either way and only the fill changed.
- **The bar floats** at `max-width: var(--page)`, so its edges line up with every
  section boundary underneath it.

Buttons press *in* on hover: the bevel flips, the face sinks and takes an inner
shadow. Nothing on this site lifts off the page.

Body copy is Rubik, self-hosted at 35 KB variable, latin only. Roboto's
proportions with softer corners. Our own name in running text gets `.wgg`:
`--brand`, bold, used for nothing else.

`web/assets/app.css` is the whole system and the landing page adds about 200
lines on top of it.

Every share card ends on the same line: "Make your own server's Wrapped free at
wrapped.gg". A card pasted into somebody else's Discord is the only distribution
this has.

There are four of them, two per subject. The link unfurls (`src/og/`, 1200×630)
are what Discord draws when a URL is posted; the downloadable cards
(`web/assets/card.js`, 1080×1350) are what someone saves at the end of a story
and posts on purpose. A player gets both, and so does the server: the server
story ends on the same modal, with the same palette swatches, rendering the
whole-server card from the summary document the build already wrote.

## Support

There is a Discord now: <https://discord.gg/hPRGgWKpTF>. It is in the header and the
footer of every app page, on the sign-in screen, in the wizard's upload step where
people get stuck, on each server's own page in the panel, at the end of the setup
guide, and in the story itself - on the gate and on the last card.

The two in the story are the deliberate ones. Most people who hit something wrong are
players, not owners: a name the search box will not find, or a number that reads
wrong. They have no reason to open the panel and nowhere else to say so. Both are
hidden inside an embed, because that frame belongs to the server owner and their
players should be asking them.

The mark is the real Discord logo. It is declared once per stylesheet as
`--discord-mark` and painted through a CSS mask, so `.i-discord` takes
`currentColor` and drops into a button, a nav row or the middle of a sentence
without a second copy of the path.

## Metrics

`GET /metrics`, Prometheus exposition format. 404s without the bearer token so
the endpoint is not discoverable.

```yaml
scrape_configs:
  - job_name: wrapped
    scheme: https
    bearer_token: <METRICS_TOKEN>
    static_configs: [{ targets: ['wrapped.gg'] }]
```

Event counters go to Analytics Engine rather than D1 or KV. Per-request counters
at $1/million (D1) or $5/million (KV) writes would cost more than the rest of the
service put together. OG images are counted split by cache hit against render,
since that ratio is the difference between pennies and real money.

Cost figures are estimates from our own counters against a rate table at the top
of `api/metrics.js`; Cloudflare's invoice is authoritative.

No page loads a third-party script. There used to be a Google Analytics tag on
all seven of them. It is gone, and `npm run test:panel` fails if one comes back.
Analytics Engine already counts everything the panel and `/metrics` report, so
the tag was costing latency and a request to somebody else's domain on every
player page while telling us nothing we did not already have.

## Bedrock players

Geyser hands Floodgate players a UUID built as `new UUID(0, xuid)`. The top 64
bits are zero and the bottom 64 are the Xbox XUID, so it reads
`00000000-0000-0000-000a-01f1c1b2d3e4`. That is the whole rule, and
`isFloodgateUuid` in `lib/util.js` is the only place it is written down.
Everything downstream comes from that one function: the `platform` column,
whether a name is worth asking Mojang about, what an unnamed player is called.

It used to be spelled `startsWith('00000000-0000-0000-0009')`, in two places.
That matched the XUIDs in circulation at the time and nothing beyond them. An
XUID of `0x000a…` or higher is every bit as much a Bedrock account, and those
were being filed as Java and posted to playerdb, which had of course never heard
of them.

Names come from `usercache.json`, where Floodgate writes the gamertag with a dot
in front of it. Plenty of servers do not have every Bedrock player in there, so
the fallback matters, and the old one was `uuid.slice(0, 8)`: the same eight
characters for **every** Floodgate account. 2,304 players across ten servers were
stored, shown and ranked as `00000000`. The fallback is now
`Bedrock-<last 6 of the xuid>`, which is stable across builds and different for
every player. `name_lower` gets the same string, so the label is searchable.

Rows written before that change still say `00000000` in D1. `isFallbackName`
treats the old value as "no name", so pages and leaderboards heal on read without
waiting for a rebuild, and the stored value is corrected the next time that
server uploads.

The label is only ever a last resort, because the gamertag can be looked up.
GeyserMC runs a public API mapping an XUID to a gamertag, and the XUID *is* the
bottom half of the UUID, which `xuidOf()` reads straight out. A Bedrock player
missing from `usercache.json` resolves through
`api.geysermc.org/v2/xbox/gamertag/<xuid>` and comes back with their real
gamertag instead of `Bedrock-ea5107`.

It is a fourth tier on the same ladder the Java names use, KV for 30 days then
the `usercache` table forever then the network, and it shares the cache, the
negative cache and the 24-lookup-per-request budget. Java accounts never touch
it, Bedrock accounts never touch playerdb. The API answers `503` for an XUID it
has not seen, which is a miss rather than an outage, so it gets negative-cached
like anything else.

Heads come from the same place. Java heads are rendered by mc-heads.net, which has
never heard of a Floodgate UUID, so Bedrock players used to get a generic fallback.
Geyser's `/v2/skin/<xuid>` returns the `texture_id` of the skin it converted when the
player joined, and that texture is a plain 64x64 PNG on `textures.minecraft.net`,
which puts the head one crop away.

`lib/skin.js` does the crop in the Worker, with no new dependency: PNG chunks parsed
by hand, IDAT inflated through `DecompressionStream('deflate')`, scanlines unfiltered
(all five filter types), the 8x8 face at (8,8) lifted out, scaled 16x nearest-neighbour
so it stays pixel art, and re-encoded with `CompressionStream` plus a CRC32 per chunk.
Verified byte-identical to what Pillow produces for the same texture. The **hat
layer at (40,8) is deliberately ignored.** The face is the face.

Only the face is read, so a 64x32 legacy skin works as well as a 64x64 one, and
anything that is not 8-bit RGB or RGBA is refused rather than guessed at. The result
goes to R2 under the same `head/<uuid>.png` key as every other head, so it is cropped
once and served from R2 forever after. A player Geyser has no skin for is remembered
in KV for six hours, so a missing skin does not become two API calls on every view.

The reverse works too. `/v2/xbox/xuid/<gamertag>` turns a gamertag back into a
Floodgate UUID, so a Bedrock player can search their own name and find their
page. A gamertag with no spaces in it is indistinguishable from a Java name, so
Java gets tried first and Geyser catches whatever falls through. A name with a
space skips straight to Geyser, since Mojang would never accept one.

## Being found

The head term is "Minecraft server wrapped", so the home page title leads with
that and not with the brand. Google appends the site name itself, and a title
opening with the product name wastes the only words anybody reads.

Four surfaces, and they have to agree:

- **The pages.** One `<title>` and one description each, unique, self-canonical, all
  `https`. `/help`, `/setup`, `/hosting` and `/partners` are aliases that serve the
  same file as `/docs` and `/hosts`, so they carry the canonical of the page they
  are an alias for and no duplicate ever competes.
- **One JSON-LD `@graph` per page**, never several blocks. The home page declares the
  `Organization`, the `WebSite`, the `SoftwareApplication` and a `FAQPage`; `/docs`
  and `/hosts` add a `BreadcrumbList`. Every question marked up as a `Question` is a
  question a reader can see on the page. `test/seo.mjs` fails if one is not,
  since invisible FAQ markup is a manual action waiting to happen.
- **`/sitemap.xml` is generated**, not a file: three static pages plus every published
  server, newest build first, each with the day it was last built as `lastmod`. Cached
  in KV for an hour. A D1 outage still returns a valid sitemap with the static pages,
  because an empty sitemap is worse than a short one.
- **`/llms.txt`** for answer engines, and `robots.txt` names GPTBot, ClaudeBot,
  PerplexityBot and Google-Extended explicitly rather than leaving them to the default.

`robots.txt` disallows only what must never be fetched: `/v1/`, `/metrics`,
`/auth/`, `/claim/`. The app pages are *crawlable and `noindex`*. Blocking them in
robots.txt would mean the crawler never sees the `noindex`, and the URL sits in
the index regardless.

Player pages are `noindex, follow` on purpose. There are tens of thousands of them,
they are thin by nature, and they belong to the player rather than to search; the
server pages are the ones worth ranking, and they are all in the sitemap.

Anything drawn into a share card is also an unfurl, so read the caching section
before touching `metaTags`. The `og:` tags and the card image have to change
together.

## Tests

```bash
node --expose-gc test/stream-world.mjs <world/stats>   # build a real server
node test/movement.mjs                   # build it twice; check what it says moved
node test/birthday.mjs                   # the world-age arithmetic, at the dates that break it
python3 test/birthday-sql.py             # the birthday column and the previous-build lookup
node test/traffic.mjs                    # the traffic report, and who each door lets in
node test/served.mjs                     # the landing count, and that it is all the page gains
node test/metrics.mjs                    # the exposition, and every dashboard panel against it
node test/seo.mjs                         # titles, canonicals, schema vs visible text, the sitemap
node test/embed.mjs                      # the embed page, its headers, and the loader contract
node test/og-preview.mjs                 # renders every share card to test/out/
node test/legacy.mjs                     # 1.7 and 1.12 stats files, and both clients reading them
node test/blocked.mjs                    # blocking: the build, the panel API, the rebuild it queues
python3 test/blocked-sql.py              # the blocklist-aware lookups, against the real schema
```

Verified against a live server's world folder: output matches the existing
site exactly, 2.4s, 19 MB working set.

None of these need `wrangler` or the Workers runtime, which is the point. A
handler takes `(request, env, ...)`, so a stub `env.DB` is enough to test one,
and the SQL runs against a throwaway SQLite built from the migrations. D1 *is*
SQLite, so those are the queries that ship and not approximations of them. The
whole suite runs anywhere, including on hosts where `workerd` will not start.

`test/movement.mjs` builds a real server three times: once to write a rank
sidecar, once after handing fifth place enough playtime to take first, and once
after adding somebody who was not there at all. Every assertion is a number you
can work out on paper. The climb is four places, exactly five players moved,
everybody else reports zero. None of it is a snapshot of whatever the code
happened to produce. The serialiser and parser it round-trips through are the
shipping ones; a format that only round-trips through a test helper has not been
tested.

## Licence

AGPL-3.0-or-later. The full text is in [LICENSE](LICENSE).

The short version: read it, run it, change it, fork it. If you run a modified
version as a network service, the people using it are entitled to your source.
That is the only condition, and it is the one that makes publishing this
sensible. Auditing it, running it for your own community, or running it for your
customers all fall inside that.

The fonts are not mine to relicence and are not covered by it:

- `web/assets/font/Minecraftia-Regular.ttf` (Andrew Tyler) is free for personal
  use. Commercial use needs a licence from the author. If you are deploying this
  somewhere that takes money, sort that out or swap the font.
- `rubik-latin.woff2` and `rubik-latin-ext.woff2` are Rubik (Hubert & Fischer,
  Meir Sadan, Cyreal) under the SIL Open Font License 1.1. Self-hosted rather
  than linked, so the site makes no third-party requests.

Minecraft is a trademark of Mojang Studios. This is not affiliated with,
endorsed by, or connected to Mojang, Microsoft or Discord.
