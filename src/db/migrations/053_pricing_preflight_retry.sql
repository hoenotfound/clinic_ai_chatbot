-- A provider-independent, bounded retry ledger for pricing send preflight checks.
-- Only verified pre-provider failures may increment this table. A Meta-accepted
-- or uncertain delivery is never automatically retried.
CREATE TABLE IF NOT EXISTS pricing_reminder_preflight_retries (
  anchor_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  package_key TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 3),
  retry_after TIMESTAMPTZ NOT NULL DEFAULT now() + interval '30 seconds',
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (anchor_id, package_key)
);
CREATE INDEX IF NOT EXISTS idx_pricing_preflight_retry_after
  ON pricing_reminder_preflight_retries (retry_after)
  WHERE attempts < 3;
