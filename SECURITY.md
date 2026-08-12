# Reporting a vulnerability

Message [Tehlo on Discord](https://discord.com/users/158577328874586112), or
open a GitHub security advisory on this repo. Please do not open a public issue
for anything exploitable.

I will confirm I have read it within a couple of days. This is one person's
project, so there is no SLA beyond that, but anything affecting other people's
data gets looked at the same day.

## What the service actually holds

Worth knowing before you go looking, because it is less than people assume:

- **Player statistics**, as uploaded. Counters keyed by UUID. No IPs, no chat,
  no coordinates, no login times.
- **Minecraft usernames**, cached against UUIDs. Public information, and the
  same lookup anybody can do against Mojang.
- **Discord id, username and avatar hash** for server owners who signed in.
  No email, no token is stored after the OAuth exchange, and nothing is written
  back to Discord.
- **Hashes of API keys.** `wgg_live_` and `wgg_host_` secrets are stored as
  SHA-256 and shown exactly once, at creation. A database dump does not let
  anybody upload.

There is no payment data, because nothing here takes payments.

## Things that are deliberate, so please do not report them

- `/metrics`, `/admin` and unknown endpoints all answer **404 rather than 403**,
  signed in or not. Telling an anonymous caller that an endpoint exists is the
  thing being avoided.
- Ownership checks are `WHERE id = ? AND owner_id = ?`, and a miss is a 404 for
  the same reason.
- Player pages are public by design once an owner publishes them. That is the
  product. The slug carries five random characters so an unpublished or
  unshared server is not guessable by name.
- `frame-ancestors *` on `/embed/*` is intentional. Any site may frame a
  published Wrapped; that is what the embed is for. The app pages answer
  `x-frame-options: DENY`.
- The build runs on a queue and a malformed upload fails there rather than on
  the request path. A snapshot that breaks the build is a bug report, not a
  vulnerability, unless it does something other than fail.

## Things I would genuinely like to hear about

Anything that reads one tenant's data through another tenant's credentials,
anything that turns an upload key into more than uploads, SQL reaching the
Analytics Engine query builder in `api/analytics.js`, or a way to make the
`/v1/host` partner door touch a server it did not create.
