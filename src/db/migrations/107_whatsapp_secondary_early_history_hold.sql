-- Additive, default-OFF pre-identity history/contact holding area.
-- Until Meta ownership is verified, records are encrypted and cannot enter Inbox.
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS whatsapp_secondary_early_history_hold (
  fingerprint TEXT PRIMARY KEY CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  candidate_waba_id TEXT NOT NULL CHECK(candidate_waba_id ~ '^[0-9]{1,32}$'),
  candidate_phone_number_id TEXT NOT NULL CHECK(candidate_phone_number_id ~ '^[0-9]{1,32}$'),
  event_field TEXT NOT NULL CHECK(event_field IN ('history','smb_app_state_sync')),
  nonce BYTEA NOT NULL CHECK(octet_length(nonce)=12),
  ciphertext BYTEA NOT NULL CHECK(octet_length(ciphertext)>0 AND octet_length(ciphertext)<=8388608),
  auth_tag BYTEA NOT NULL CHECK(octet_length(auth_tag)=16),
  payload_bytes INTEGER NOT NULL CHECK(payload_bytes BETWEEN 1 AND 8388608),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '48 hours')
);
CREATE INDEX IF NOT EXISTS idx_secondary_early_history_handoff
  ON whatsapp_secondary_early_history_hold(candidate_waba_id,candidate_phone_number_id,received_at)
;
CREATE INDEX IF NOT EXISTS idx_secondary_early_history_expiry
  ON whatsapp_secondary_early_history_hold(expires_at);
COMMENT ON TABLE whatsapp_secondary_early_history_hold IS
 'Encrypted, signed but UNVERIFIED Meta history/contact event holds; no customer import, AI, marketing, or send permitted. Delete after durable import-job handoff; expired unverified data requires operator cleanup.';
