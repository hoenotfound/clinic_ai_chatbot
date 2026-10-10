-- A staff billing warning acknowledgment can authorize at most one manual
-- WhatsApp template send. An attempted send can remain unknown/chargeable after
-- a process crash, so claims are not automatically returned to the pool.
CREATE TABLE IF NOT EXISTS whatsapp_manual_template_billing_claims (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  staff_username TEXT NOT NULL,
  template_name TEXT NOT NULL,
  language_code TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_manual_billing_claims_contact
 ON whatsapp_manual_template_billing_claims (contact_id, claimed_at DESC);
