PRAGMA foreign_keys = ON;

ALTER TABLE partners ADD COLUMN suspended_at INTEGER;
ALTER TABLE partners ADD COLUMN notes TEXT;

CREATE TABLE IF NOT EXISTS admin_audit (
  id      TEXT PRIMARY KEY,
  at      INTEGER NOT NULL,
  actor   TEXT NOT NULL,
  action  TEXT NOT NULL,
  target  TEXT,
  label   TEXT,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON admin_audit(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_target ON admin_audit(target, at DESC);
