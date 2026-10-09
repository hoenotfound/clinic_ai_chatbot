-- Verified marketing consent is staff recorded and never inferred from ad clicks.
CREATE TABLE IF NOT EXISTS whatsapp_marketing_consent_events (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  recorded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_marketing_consent_events_contact ON whatsapp_marketing_consent_events (contact_id, created_at DESC);