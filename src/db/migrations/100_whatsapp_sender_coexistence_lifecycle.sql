-- Coexistence partner-removal evidence and fail-closed sender suspension.
-- Additive only: no changes to legacy primary WhatsApp tables or contacts.
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_coexistence_lifecycle_events (
  fingerprint TEXT PRIMARY KEY CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  event_type TEXT NOT NULL CHECK(event_type IN ('PARTNER_REMOVED','ACCOUNT_OFFBOARDED','ACCOUNT_RECONNECTED')),
  account_id TEXT NOT NULL CHECK(account_id ~ '^[0-9]+$'),
  phone_number TEXT,
  action TEXT NOT NULL CHECK(action IN ('disabled','reconnect_review')),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_coexistence_lifecycle_sender
  ON whatsapp_sender_coexistence_lifecycle_events(sender_id, recorded_at DESC);
