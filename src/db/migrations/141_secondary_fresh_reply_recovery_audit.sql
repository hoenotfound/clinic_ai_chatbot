-- Preserve the original evidence basis and separately identify who/what
-- authorized a distinct new send. Existing rows are not reclassified.
SET LOCAL lock_timeout = '3s';
ALTER TABLE whatsapp_sender_unknown_gate_new_sends
  ADD COLUMN IF NOT EXISTS authorization_source TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS recovery_inbound_message_id INTEGER;
ALTER TABLE whatsapp_sender_unknown_gate_new_sends
  ADD CONSTRAINT secondary_unknown_new_send_authorization_source
  CHECK (authorization_source IN ('legacy','signed_failure','operator_allowlist','inbox_review','automatic_fresh_service_reply'));
COMMENT ON COLUMN whatsapp_sender_unknown_gate_new_sends.authorization_source IS
  'Automatic fresh service reply accepts potential billing exposure; it does not certify historical non-delivery or no charge.';
