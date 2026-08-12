<img width="1734" height="154" alt="image" src="https://github.com/user-attachments/assets/d3ad610c-379c-4225-9eb5-dc5dec5f58d7" />


# wrapped.gg

A year-in-review for any Minecraft server, like the one your music app sends you
in December. Every player gets a page of their own year: hours played, blocks
mined, how far they walked, what they died to most, where they rank against
everybody else on the server, and a card they can post about it.

It needs no plugin and no mod. Minecraft already writes a `stats/` folder next
to the world, one JSON file per player, and that folder is the whole input. The
server owner uploads it once and every player on it has a page. Nothing runs
alongside the game, nothing connects to it, and it works the same on a €3 shared
host as on a dedicated box, on Vanilla, Paper, Spigot, Purpur, Fabric, Forge or
NeoForge.

This is the source for the service running at [wrapped.gg](https://wrapped.gg).
It is public because hosting companies wiring it into their panels asked to see
what happens to their customers' data before sending any, which is fair. The
operator support portal is the one part kept private.

## What it does

An owner uploads the stats folder, either by dropping it into the browser or by
running one line on the server:

```
curl -sL https://wrapped.gg/u | sh -s -- --key wgg_live_xxx
```

The upload goes straight to object storage without being parsed, and a queue
picks it up. The build folds the file one player at a time, ranks everybody
against everybody, and writes out one page document per player plus a summary
for the server. After that a page view is a single indexed database lookup and
one ranged read of about 4 KB.

The result is `wrapped.gg/<server>` for the whole server and
`wrapped.gg/<server>/<player>` for one person. Players find themselves by typing
their name. Owners can re-upload whenever they like, and each build says what
moved since the last one.

It runs entirely on Cloudflare: Workers, D1, R2, Queues and Analytics Engine.
There is no container and no server to keep alive.

## Features

**For players**

- A story of about twenty cards, and only cards backed by a real number. No
  padding.
- 216 ranked awards across mining, combat, crafting, travel, farming and the
  stranger corners of the stats file.
- Rank and percentile on nine boards: playtime, blocks mined, mobs killed, items
  crafted, items used, distance, deaths, jumps and damage dealt.
- Movement since the last upload, so a card can say you passed four people
  rather than just where you stand.
- A downloadable 1080x1350 card drawn in the browser, plus a 1200x630 image that
  unfurls when the link is pasted into Discord.
- Java and Bedrock players both, including real gamertags and real Bedrock skin
  heads rather than a generic fallback.

**For server owners**

- A four-step setup: name and icon, pick how to send stats, send them, publish.
- Upload from the browser or from a shell one-liner that finds the world itself.
- Your name, your icon and one of six colour palettes on the page and on every
  share card.
- A whole-server page with leaderboards, on the same URL as the player pages.
- An embed for your own site, two lines of HTML, that opens full screen when a
  player starts their story.
- A 30-day traffic report: page views, player pages opened, link previews shown.
- A blocklist for banned accounts, alts and staff characters. Blocked players
  are removed from the build entirely, not hidden on the way out, so they do not
  sit in anybody else's ranking.
- An optional world creation date, which turns the page into a birthday for the
  week around it.

**For hosting providers**

- A separate API at `/v1/host`: one partner token, many customer servers, no
  Discord login in the middle of your panel.
- Servers addressable by your own id, and creation is idempotent on it, so a
  retried request never produces a second page.
- Claim links that hand a page over to the customer's own account.
- Nothing to run and nothing to install. Post the stats folder, get a URL.

**Everywhere**

- Reads files, never the server. No RCON, no query port, no Microsoft or Mojang
  authentication, and nothing written back to Minecraft.
- Stats files from Minecraft 1.7 onwards, including the numeric block ids and
  dotted key names that predate 1.13.
- No third-party scripts on any page.

### This readme was generated with the help of AI.
