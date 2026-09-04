-- Persistent brute-force protection for the staff login endpoint.
--
-- Identifiers are HMAC-hashed before they reach this table, so raw client IPs
-- and attempted usernames are not retained just to enforce rate limits.
CREATE TABLE IF NOT EXISTS login_rate_limits (
  scope TEXT NOT NULL CHECK (scope IN ('ip', 'username', 'pair')),
  key_hash TEXT NOT NULL,
  failures INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, key_hash)
);

CREATE INDEX IF NOT EXISTS idx_login_rate_limits_updated_at
  ON login_rate_limits (updated_at);
