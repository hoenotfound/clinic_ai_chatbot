-- Phase 2C: isolated Ariel receipts and pending-status inspection.
-- No legacy Neutro table changes or operational flag activation.
SET LOCAL lock_timeout = '3s';

ALTER TABLE whatsapp_sender_billing_attempts
  ADD CONSTRAINT whatsapp_sender_billing_attempts_reservation_sender_unique
  UNIQUE (reservation_id, sender_id);

CREATE TABLE IF NOT EXISTS whatsapp_sender_status_receipts (
  fingerprint TEXT PRIMARY KEY CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  reservation_id UUID,
  wamid TEXT,
  wamid_hash TEXT NOT NULL CHECK (wamid_hash ~ '^[0-9a-f]{64}$'),
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('sent','delivered','read','failed')),
  pricing_type TEXT,
  pricing_billable BOOLEAN,
  pricing_category TEXT,
  meta_phone_number_id TEXT NOT NULL CHECK (meta_phone_number_id ~ '^[0-9]+$'),
  meta_account_id TEXT NOT NULL CHECK (meta_account_id ~ '^[0-9]+$'),
  matched BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_sender_status_receipt_attempt_fk
    FOREIGN KEY (reservation_id,sender_id)
    REFERENCES whatsapp_sender_billing_attempts(reservation_id,sender_id)
    ON DELETE RESTRICT,
  CONSTRAINT whatsapp_sender_status_receipt_match_consistent
    CHECK ((matched AND reservation_id IS NOT NULL AND wamid IS NOT NULL)
       OR (NOT matched AND reservation_id IS NULL AND wamid IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_status_receipts_attempt
  ON whatsapp_sender_status_receipts(reservation_id,received_at DESC)
  WHERE matched=TRUE;
CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_status_receipts_unmatched
  ON whatsapp_sender_status_receipts(sender_id,received_at DESC)
  WHERE matched=FALSE;

COMMENT ON TABLE whatsapp_sender_status_receipts IS
  'Signed provider-status audit for a single verified WhatsApp sender. Unmatched WAMIDs are SHA256-hashed; raw messages, phone numbers and webhook payloads are not retained. This ledger never authorizes automatic retries.';
