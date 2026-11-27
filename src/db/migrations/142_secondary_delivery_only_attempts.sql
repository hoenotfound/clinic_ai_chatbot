SET LOCAL lock_timeout = '3s';
ALTER TABLE whatsapp_sender_billing_attempts
  ADD COLUMN IF NOT EXISTS delivery_only BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE whatsapp_sender_billing_attempts
  DROP CONSTRAINT whatsapp_sender_billing_attempts_state_check;
ALTER TABLE whatsapp_sender_billing_attempts
  ADD CONSTRAINT whatsapp_sender_billing_attempts_state_check
  CHECK (state IN ('reserved','awaiting_pricing','unknown','reconciled','rejected','accepted'));
CREATE UNIQUE INDEX IF NOT EXISTS secondary_delivery_only_message_once
  ON whatsapp_sender_billing_attempts(message_id) WHERE delivery_only AND message_id IS NOT NULL;
COMMENT ON COLUMN whatsapp_sender_billing_attempts.delivery_only IS
  'One-shot send and delivery evidence only; no local billing decision or reconciliation.';
