-- QA NEON ONLY. Not under src/db/migrations and NEVER run on Neutro production.
-- Manual DDL requires approval and verifying the exact QA Neon project.
-- Captures only AES-256-GCM encrypted, HMAC-verified events from a pinned
-- secondary sender. Nothing in this table triggers AI or outbound messaging.
BEGIN;
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_secondary_qa_capture_events (
  fingerprint TEXT PRIMARY KEY CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id)
    ON DELETE RESTRICT,
  event_field TEXT NOT NULL CHECK (event_field IN
    ('messages','smb_message_echoes','history','smb_app_state_sync')),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) BETWEEN 1 AND 2097152),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes BETWEEN 1 AND 2097152),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at > received_at AND expires_at <= received_at + INTERVAL '73 hours')
);
CREATE INDEX IF NOT EXISTS idx_secondary_qa_capture_expiry
 ON whatsapp_secondary_qa_capture_events (expires_at);
COMMENT ON TABLE whatsapp_secondary_qa_capture_events IS
 'Isolated QA only. AES-GCM encrypted signed secondary events for manual review; NEVER use for Neutro / AI / follow-ups. No production migrations.';
COMMIT;

-- Retention is a policy, not a PostgreSQL automatic TTL. An approved QA-only
-- operator must run this pruning SQL regularly; capture must stay OFF until
-- expiry handling is verified:
-- DELETE FROM whatsapp_secondary_qa_capture_events
--   WHERE expires_at < NOW();
