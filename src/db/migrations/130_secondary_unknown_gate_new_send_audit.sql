-- Neutro-only, opt-in audit for a NEW message after an aged UNKNOWN
-- secondary WhatsApp billing hold. This is not proof of delivery or charge,
-- and is NOT a replay/authorization of the old outbound message.
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_unknown_gate_new_sends (
  old_reservation_id UUID PRIMARY KEY
    REFERENCES whatsapp_sender_billing_attempts(reservation_id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL
    REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  old_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  new_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  basis TEXT NOT NULL CHECK (basis IN ('signed_failed','unconfirmed_no_wamid')),
  reopened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_sender_new_message_is_distinct
    CHECK (new_message_id<>old_message_id),
  CONSTRAINT whatsapp_sender_new_send_owner
    FOREIGN KEY (contact_id,sender_id)
    REFERENCES contacts(id,whatsapp_sender_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_unknown_gate_new_sends_contact
  ON whatsapp_sender_unknown_gate_new_sends(sender_id,contact_id,reopened_at DESC);
COMMENT ON TABLE whatsapp_sender_unknown_gate_new_sends IS
  'New-send-only override for an aged unknown secondary contact billing gate. The original attempt and its Meta delivery status remain unknown/failed. It does not confirm no charges, permit original retry, or bypass WhatsApp policy.';
