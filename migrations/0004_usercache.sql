PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS usercache (
  uuid       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  name_lower TEXT NOT NULL,
  source     TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_usercache_name ON usercache(name_lower, updated_at DESC);
