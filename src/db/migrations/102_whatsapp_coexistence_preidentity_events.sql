-- PR395: audit Meta-signed secondary account_update before Embedded Signup returns IDs.
-- This table is isolated to the QA Neon database; no production sender records
-- or legacy contact/message tables are changed.
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_coexistence_preidentity_events (
  fingerprint TEXT PRIMARY KEY CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  candidate_waba_id TEXT NOT NULL CHECK (candidate_waba_id ~ '^[0-9]+$'),
  candidate_phone_e164 TEXT NOT NULL CHECK (candidate_phone_e164 ~ '^\\+[1-9][0-9]{7,14}$'),
  event_type TEXT NOT NULL CHECK (char_length(event_type) BETWEEN 1 AND 64),
  entry_time BIGINT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_coex_preidentity_candidate
  ON whatsapp_coexistence_preidentity_events(candidate_waba_id,received_at DESC);
