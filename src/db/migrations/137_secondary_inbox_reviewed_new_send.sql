-- Immutable administrator evidence for a distinct staff-composed send.
-- The existing new-send audit consumes the permission; never replay the old message.
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_unknown_gate_inbox_reviews (
  reservation_id UUID PRIMARY KEY REFERENCES whatsapp_sender_billing_attempts(reservation_id) ON DELETE RESTRICT,
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  old_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 100),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 12 AND 500),
  non_delivery_checked BOOLEAN NOT NULL CHECK (non_delivery_checked),
  billing_no_charge_checked BOOLEAN NOT NULL CHECK (billing_no_charge_checked),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (contact_id,sender_id) REFERENCES contacts(id,whatsapp_sender_id) ON DELETE CASCADE
);
