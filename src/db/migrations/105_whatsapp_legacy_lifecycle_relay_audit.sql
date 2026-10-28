-- PR395: separate, review-only account lifecycle audit for a verified legacy
-- WABA while evaluating an app-default webhook relay cutover.
-- Deliberately isolated from customer contacts and existing production senders.
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS whatsapp_legacy_lifecycle_relay_audit (
  fingerprint TEXT PRIMARY KEY CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
  account_id TEXT NOT NULL CHECK(account_id ~ '^[0-9]+$'),
  event_type TEXT NOT NULL CHECK(event_type ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  account_phone_e164 TEXT CHECK(account_phone_e164 ~ '^[+][1-9][0-9]{7,14}$'),
  entry_time BIGINT,
  handling_status TEXT NOT NULL DEFAULT 'review_required'
    CHECK(handling_status IN ('review_required','reviewed')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_legacy_lifecycle_review
  ON whatsapp_legacy_lifecycle_relay_audit(handling_status,recorded_at DESC);
