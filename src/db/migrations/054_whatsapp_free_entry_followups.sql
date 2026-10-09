-- Durable billing evidence and one-shot extended WhatsApp template attempts.
-- No historical records are assumed to have received a free entry window.
CREATE TABLE IF NOT EXISTS whatsapp_free_entry_pricing_evidence (
  wamid TEXT PRIMARY KEY,
  pricing_type TEXT NOT NULL,
  billable BOOLEAN,
  delivery_status TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS whatsapp_free_entry_followup_attempts (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  first_reply_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  slot_hours INTEGER NOT NULL CHECK (slot_hours BETWEEN 25 AND 167),
  status TEXT NOT NULL DEFAULT 'sending'
    CHECK (status IN ('sending','accepted','failed','unknown','cancelled')),
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  wamid TEXT,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (first_reply_message_id, slot_hours)
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_fep_attempts_contact
  ON whatsapp_free_entry_followup_attempts(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_whatsapp_fep_evidence_observed
  ON whatsapp_free_entry_pricing_evidence(observed_at);

COMMENT ON TABLE whatsapp_free_entry_followup_attempts IS
  'Each slot is claimed once before the provider call. Unknown delivery remains blocked from retry to prevent duplicates.';
