-- Phase 2: verified, no-charge auto-settlement evidence for the
-- secondary sender only. Never assert manual Billing Hub verification.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS whatsapp_sender_auto_reconciliations (
  reservation_id UUID PRIMARY KEY,
  sender_id BIGINT NOT NULL,
  provider_receipt_fingerprint TEXT NOT NULL
    REFERENCES whatsapp_sender_status_receipts(fingerprint) ON DELETE RESTRICT,
  method TEXT NOT NULL DEFAULT 'signed_meta_nonbillable_free_entry'
    CHECK (method='signed_meta_nonbillable_free_entry'),
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_sender_auto_reconciliation_attempt_fk
    FOREIGN KEY (reservation_id,sender_id)
      REFERENCES whatsapp_sender_billing_attempts(reservation_id,sender_id)
      ON DELETE RESTRICT
);

COMMENT ON TABLE whatsapp_sender_auto_reconciliations IS
  'Only an exact signed Meta billable=false free-entry receipt may clear a secondary sender gate. Late contradictory receipts latch its sender alarm.';
