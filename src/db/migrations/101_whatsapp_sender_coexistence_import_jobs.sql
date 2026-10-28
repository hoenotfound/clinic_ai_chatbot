-- Signed WhatsApp Business App history/contact webhooks can be large.
-- Stage their verified content durably BEFORE ACK, import in bounded worker
-- batches, and erase raw customer payload after successful import or expiry.
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_coexistence_import_jobs (
 fingerprint TEXT PRIMARY KEY CHECK(fingerprint ~ '^[0-9a-f]{64}$'),
 sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
 event_field TEXT NOT NULL CHECK(event_field IN('history','smb_app_state_sync')),
 payload JSONB,
 status TEXT NOT NULL DEFAULT 'pending'
   CHECK(status IN('pending','processing','completed','failed','expired')),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 20),
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 last_error TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coexistence_import_pending
 ON whatsapp_sender_coexistence_import_jobs(next_attempt_at,fingerprint)
 WHERE status='pending';
COMMENT ON COLUMN whatsapp_sender_coexistence_import_jobs.payload IS
 'Sensitive Meta-signed one-time history/contact sync chunk. Erase after import; never expose to the portal or treat as marketing consent.';
