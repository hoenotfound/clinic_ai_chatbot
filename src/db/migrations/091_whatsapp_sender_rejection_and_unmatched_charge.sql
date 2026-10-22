-- Explicit non-acceptance is not a possible Meta duplicate. Unexpected
-- signed charges without a matched reservation still halt the sender.
SET LOCAL lock_timeout = '3s';
ALTER TABLE whatsapp_sender_billing_attempts
 DROP CONSTRAINT whatsapp_sender_billing_attempts_state_check;
ALTER TABLE whatsapp_sender_billing_attempts
 ADD CONSTRAINT whatsapp_sender_billing_attempts_state_check
 CHECK (state IN ('reserved','awaiting_pricing','unknown','reconciled','rejected'));
ALTER TABLE whatsapp_sender_billing_alarms
 ALTER COLUMN reservation_id DROP NOT NULL;
ALTER TABLE whatsapp_sender_billing_alarms
 DROP CONSTRAINT whatsapp_sender_billing_alarms_reason_check;
ALTER TABLE whatsapp_sender_billing_alarms
 ADD CONSTRAINT whatsapp_sender_billing_alarms_reason_check
 CHECK (reason IN ('provider_billable','provider_delivery_failed','unmatched_provider_billable'));
COMMENT ON COLUMN whatsapp_sender_billing_alarms.reservation_id IS
 'NULL means a signed unexpected billable provider status could not be linked to any local send; it must not be attributed to an arbitrary customer.';
