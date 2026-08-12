PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  discord_id    TEXT NOT NULL UNIQUE,
  username      TEXT NOT NULL,
  avatar        TEXT,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS servers (
  id             TEXT PRIMARY KEY,
  slug           TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  icon_key       TEXT,
  palette        INTEGER NOT NULL DEFAULT 0,
  owner_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  baseline_snapshot_id TEXT,
  published      INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id);

CREATE TABLE IF NOT EXISTS reserved_slugs (slug TEXT PRIMARY KEY);
INSERT OR IGNORE INTO reserved_slugs(slug) VALUES
  ('api'),('app'),('panel'),('dashboard'),('login'),('logout'),('auth'),
  ('admin'),('static'),('assets'),('cdn'),('img'),('images'),('u'),('up'),
  ('upload'),('docs'),('help'),('support'),('about'),('terms'),('privacy'),
  ('pricing'),('blog'),('status'),('health'),('robots.txt'),('sitemap.xml'),
  ('favicon.ico'),('og'),('embed'),('new'),('settings'),('account');

CREATE TABLE IF NOT EXISTS api_keys (
  id          TEXT PRIMARY KEY,
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  key_hash    TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_keys_server ON api_keys(server_id);

CREATE TABLE IF NOT EXISTS snapshots (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL,
  idem_key     TEXT NOT NULL,
  taken_at     INTEGER NOT NULL,
  received_at  INTEGER NOT NULL,
  source       TEXT NOT NULL,
  players      INTEGER NOT NULL,
  bytes        INTEGER NOT NULL,
  state        TEXT NOT NULL DEFAULT 'queued',
  error        TEXT,
  built_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_snap_idem ON snapshots(server_id, idem_key);
CREATE INDEX IF NOT EXISTS idx_snap_server ON snapshots(server_id, taken_at DESC);

CREATE TABLE IF NOT EXISTS builds (
  id             TEXT PRIMARY KEY,
  server_id      TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  baseline_id    TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
  latest_id      TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  window_from    INTEGER,
  window_to      INTEGER NOT NULL,
  players        INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  is_live        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_builds_server ON builds(server_id, created_at DESC);

CREATE TABLE IF NOT EXISTS players (
  server_id   TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  uuid        TEXT NOT NULL,
  name        TEXT NOT NULL,
  name_lower  TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT 'java',
  playtime_h  REAL NOT NULL DEFAULT 0,
  pack_off    INTEGER NOT NULL DEFAULT 0,
  pack_len    INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (server_id, uuid)
);
CREATE INDEX IF NOT EXISTS idx_players_lookup ON players(server_id, name_lower);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
