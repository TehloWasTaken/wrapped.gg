CREATE TABLE IF NOT EXISTS blocked_players (
  server_id  TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  uuid       TEXT NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (server_id, uuid)
);
CREATE INDEX IF NOT EXISTS idx_blocked_server ON blocked_players(server_id, created_at DESC);
