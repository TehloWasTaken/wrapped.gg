PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS partners (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  contact     TEXT,
  website     TEXT,
  token_hash  TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  max_servers INTEGER NOT NULL DEFAULT 10000,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at  INTEGER
);

ALTER TABLE servers ADD COLUMN partner_id   TEXT;
ALTER TABLE servers ADD COLUMN external_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_partner_ref
  ON servers(partner_id, external_ref);
CREATE INDEX IF NOT EXISTS idx_servers_partner ON servers(partner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS claim_tokens (
  token_hash TEXT PRIMARY KEY,
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  used_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_claims_server ON claim_tokens(server_id);

INSERT OR IGNORE INTO reserved_slugs(slug) VALUES
  ('hosts'),('host'),('hosting'),('partner'),('partners'),('claim');
