-- Strict automatic resolution only for exact HMAC-matched Meta
-- FAILED receipts with explicit pricing_billable=FALSE and no contradiction.
-- No human/operator signatures. Do not modify the original manual audit.
-- No original message is retried and no new send is authorized.
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_automatic_unknown_hold_releases (
 reservation_id UUID PRIMARY KEY REFERENCES whatsapp_sender_billing_attempts(reservation_id) ON DELETE RESTRICT,
 sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
 contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
 message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
 proof_receipt_fingerprint TEXT NOT NULL
   REFERENCES whatsapp_sender_status_receipts(fingerprint) ON DELETE RESTRICT,
 release_reason TEXT NOT NULL DEFAULT 'signed_failed_nonbillable'
   CHECK(release_reason='signed_failed_nonbillable'),
 original_message_retry_prohibited BOOLEAN NOT NULL DEFAULT TRUE
   CHECK(original_message_retry_prohibited=TRUE),
 released_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 FOREIGN KEY(contact_id,sender_id) REFERENCES contacts(id,whatsapp_sender_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_auto_unknown_hold_contact
 ON whatsapp_sender_automatic_unknown_hold_releases(sender_id,contact_id,released_at DESC);
COMMENT ON TABLE whatsapp_sender_automatic_unknown_hold_releases IS
 'Unattended release after signed sender-bound FAILED with explicit Meta non-billable proof; no missing-receipt inference, new customer sends, or original replay.';
