-- Preserve minimal nonidentifying billing facts across an authorized
-- customer erasure. No customer ID, WAMID, phone, media or message content.
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_erased_billing_audit (
  reservation_sha256 TEXT PRIMARY KEY CHECK (reservation_sha256 ~ '^[a-f0-9]{64}$'),
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  previous_state TEXT NOT NULL,
  staff_charge_approved BOOLEAN NOT NULL DEFAULT FALSE,
  billable_receipt_seen BOOLEAN NOT NULL DEFAULT FALSE,
  erased_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE whatsapp_sender_billing_alarms
 DROP CONSTRAINT whatsapp_sender_billing_alarms_reason_check;
ALTER TABLE whatsapp_sender_billing_alarms
 ADD CONSTRAINT whatsapp_sender_billing_alarms_reason_check
 CHECK (reason IN (
   'provider_billable','provider_delivery_failed','unmatched_provider_billable',
   'purged_unresolved_reservation'
 ));
