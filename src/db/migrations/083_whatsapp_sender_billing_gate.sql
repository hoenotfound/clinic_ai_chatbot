-- Phase 2B: additive secondary-sender billing reservation foundation.
-- This table is not read by the legacy Neutro strict-RM0 workers.
-- The new sender's delivery/status/reconciliation worker must be finished
-- before any second-number transport is connected to customer sends.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS whatsapp_sender_billing_gates (
  sender_id BIGINT NOT NULL
    REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  owner_contact_id INTEGER NOT NULL,
  PRIMARY KEY (sender_id, owner_contact_id),
  CONSTRAINT whatsapp_sender_gate_owner_fk
    FOREIGN KEY (owner_contact_id, sender_id)
    REFERENCES contacts(id,whatsapp_sender_id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'idle'
    CHECK (state IN ('idle','reserved','awaiting_pricing','unknown')),
  reservation_id UUID,
  contact_id INTEGER,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  wamid TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_sender_gate_contact_owner
    FOREIGN KEY (contact_id, sender_id)
    REFERENCES contacts(id,whatsapp_sender_id) ON DELETE RESTRICT,
  CONSTRAINT whatsapp_sender_gate_state_consistent
    CHECK (
      (state = 'idle' AND reservation_id IS NULL AND
       contact_id IS NULL AND wamid IS NULL)
      OR
      (state = 'reserved' AND reservation_id IS NOT NULL
       AND contact_id IS NOT NULL AND wamid IS NULL)
      OR
      (state = 'awaiting_pricing' AND reservation_id IS NOT NULL
       AND contact_id IS NOT NULL AND wamid IS NOT NULL)
      OR
      (state = 'unknown' AND reservation_id IS NOT NULL
       AND contact_id IS NOT NULL)
    )
);

-- A sender can retain historical accounting events without opening a gate.
-- Reconciliation writes are intentionally excluded until provider status
-- handling verifies the Meta business identity and nonbillable outcome.
CREATE TABLE IF NOT EXISTS whatsapp_sender_billing_attempts (
  reservation_id UUID PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  contact_id INTEGER NOT NULL,
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','awaiting_pricing','unknown','reconciled')),
  wamid TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_sender_attempt_contact_owner
    FOREIGN KEY (contact_id, sender_id)
    REFERENCES contacts(id,whatsapp_sender_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_billing_attempts_sender
  ON whatsapp_sender_billing_attempts(sender_id,created_at DESC);

COMMENT ON TABLE whatsapp_sender_billing_gates IS
  'Secondary sender AND contact reservation. Distinct customers may send concurrently; one contact cannot resend unresolved work, and sender-wide alarms still block all contacts.';
