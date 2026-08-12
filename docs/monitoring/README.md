# Monitoring

`GET /metrics` on your deployment, in Prometheus exposition format, which
VictoriaMetrics scrapes natively.

The endpoint returns **404** without a valid bearer token, not 401, so an
unauthenticated caller cannot tell it exists.

## 1. Check it works

```bash
curl -H "Authorization: Bearer $METRICS_TOKEN" https://your-domain/metrics | head
```

Expect `# HELP wrapped_users_total …`. A 404 means the token does not match
what `wrangler secret put METRICS_TOKEN` was given.

## 2. Point a scraper at it

Already running VictoriaMetrics or Prometheus? Add the job in `scrape.yml`.

Starting from nothing? `docker-compose.yml` here brings up VictoriaMetrics and
Grafana with the datasource pre-wired:

```bash
mkdir -p /opt/monitoring && cd /opt/monitoring
cp <this repo>/docs/monitoring/{docker-compose.yml,prometheus.yml,datasource.yml} .
echo -n 'YOUR_METRICS_TOKEN' > wrapped-gg.token && chmod 600 wrapped-gg.token
docker compose up -d
```

Grafana on `127.0.0.1:3001` (admin / changeme, so change it). Both bind to
localhost on purpose: put them behind your existing proxy rather than exposing
a metrics database.

Retention is set to 13 months so a year-in-review product can be compared year
on year.

## Every series is emitted on every scrape

A Prometheus panel says "No data" when the *series* is absent, which is not the
same as the value being zero, and an absent series is what you get if you only
emit what a `GROUP BY` happened to return. So the endpoint emits a fixed set:
every snapshot state, every partner state, every event split, every window,
zero-filled. `wrapped_snapshots_by_state{state="queued"}` is `0` on a quiet day
rather than missing, and the event metrics report `0` instead of vanishing when Analytics
Engine cannot be reached.

`wrapped_analytics_available` is `1` when the Analytics Engine query behind the
event metrics succeeded on that scrape and `0` when it did not. It is always
emitted; a dashboard reading it as `0` means every event panel is showing zeros
rather than truth, and the two `CF_*` secrets need checking.

## What is exposed

**State** (exact, from D1; these are COUNT queries rather than samples)

| Metric | |
|---|---|
| `wrapped_users_total` / `_new_30d` | Discord accounts signed in, partner logins excluded |
| `wrapped_servers_total` / `_published` / `_active_30d` / `_partner_owned` | tenants |
| `wrapped_players_indexed` / `_bedrock` / `wrapped_players_live` | players across live builds |
| `wrapped_player_hours_total` | sum of playtime |
| `wrapped_builds_total`, `wrapped_snapshots_total` / `_24h` | throughput |
| `wrapped_snapshots_by_state{state=…}` | queued / building / ready / failed |
| `wrapped_snapshots_stuck` | still building an hour after arriving |
| `wrapped_partners_total`, `wrapped_partners_by_state{state=…}` | active / paused / revoked |
| `wrapped_claims_open`, `wrapped_usercache_entries` | claim links out, uuid→name pairs held |
| `wrapped_r2_snapshot_bytes` | raw snapshots held |

**Events** (from Analytics Engine, 24h and 30d windows)

`wrapped_page_view_*`, `wrapped_player_read_*`, `wrapped_og_image_*`,
`wrapped_head_image_*`, `wrapped_snapshot_upload_*`, `wrapped_build_*`,
`wrapped_name_lookup_*`, each as a total and split by one label:

| Family | Split |
|---|---|
| `wrapped_page_view_<win>_by_kind` | `player` / `server` |
| `wrapped_player_read_<win>_by_result` | `hit` / `miss` |
| `wrapped_og_image_<win>_by_result` | `cached` / `rendered` |
| `wrapped_head_image_<win>_by_result` | `cached` / `fetched` |
| `wrapped_snapshot_upload_<win>_by_source` | `browser` / `shell` / `pterodactyl` / … |
| `wrapped_build_<win>_by_result` | `ok` / `failed` |
| `wrapped_name_lookup_<win>_by_tier` | `kv` / `usercache` / `mojang` |

The split lives in a different blob for two of them: `head_image` and
`name_lookup` carry theirs in `blob2`, because those two never had a slug to put
there. `src/lib/metrics.js` is the authority on which is which.

**Estimated spend**

`wrapped_est_cost_usd_month`, plus requests, CPU-ms and storage. These are
computed from our own counters against a rate table at the top of
`src/api/metrics.js`. Cloudflare's invoice is authoritative. They exist to spot
a trend before the invoice arrives, not to replace it.

## Two panels worth building first

**OG cache hit ratio.** This is the difference between pennies and real money.
each rendered image costs ~250ms of CPU, each cached one costs nothing.

```promql
wrapped_og_image_24h_by_result{result="cached"}
  / clamp_min(scalar(sum(wrapped_og_image_24h_by_result)), 1)
```

Should sit near 1. If it falls, images are being re-rendered instead of served
from R2, so check that builds are not churning.

The `scalar()` matters. Dividing a labelled series by a bare `sum(…)` looks
right and returns nothing at all: the left side carries `result="cached"`, the
right side carries no labels, so vector matching finds no pair and the panel
reads "No data". `scalar()` turns the divisor into a plain number, which keeps
the left side's labels. Every ratio on the dashboard is written this way, and
`npm run test:metrics` fails if a new one is not.

**Failed builds.**

```promql
wrapped_snapshots_by_state{state="failed"}
```

Alert on any increase. A failed build means someone's upload silently did not
become a page, and they will not know.

## Grafana dashboard

`grafana-dashboard.json`. Import it via **Dashboards → New → Import → Upload
JSON**, then pick your VictoriaMetrics datasource when prompted.

64 panels across seven rows, each answering a different question:

| Row | Question |
|---|---|
| **Adoption** | Is anyone using this? Servers, owners, publish rate, 30-day retention |
| **Traffic** | How much is it being looked at? Views by kind, lookups and their miss rate, link previews, head cache, name-lookup tiers |
| **Pipeline health** | Did the uploads actually become pages? States, stuck builds, uploads by source, build failure rate |
| **Cost** | What is this costing, and why? |
| **Audience** | Java vs Bedrock, players per server |
| **Partners** | The hosting front door: partners by state, partner-owned servers, claim links outstanding |
| **Plumbing** | Is the telemetry itself working? |

Every panel carries a description explaining what it means and when to care.
hover the ⓘ.

`npm run test:metrics` is what keeps that true. It scrapes the endpoint against
a stub D1, then reads this dashboard file and asserts that every metric a panel
queries is emitted, every `label="value"` filter is a label value that is
emitted, no ratio divides a labelled vector by a bare `sum()`, every metric the
endpoint emits appears on some panel, and no two panels overlap on the grid. A
panel cannot go quietly stale without failing the test.

### The four panels that matter most

**Failed snapshots** (`wrapped_snapshots_by_state{state="failed"}`). Alert on
any increase. A failed build means somebody's upload silently never became a
page and they will not find out on their own.

**OG cache hit ratio**, the difference between pennies and real money. Each
cached preview is free; each render is ~250 ms of CPU. Should sit near 1; if it
falls, something is invalidating the cache key.

**Publish rate** (`published / total`): of everyone who created a server, how
many finished. A low number is an onboarding problem, not a marketing one.

**Analytics pipeline**, reading `wrapped_analytics_available`. OK when the last
scrape reached Analytics Engine, BROKEN when it did not. BROKEN means every
event panel is drawing zeros, and the two `CF_*` secrets need checking.

### Reading it early on

Event metrics are rolling 24h/30d windows sampled at each scrape, and Analytics
Engine has no backfill, so they start at zero from whenever the secrets were
added and fill over the first day. The D1 gauges are exact immediately.
