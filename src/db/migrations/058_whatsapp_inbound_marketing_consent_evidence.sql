-- Preserve evidence of explicit, customer-authored WhatsApp marketing opt-in.
-- Do not backfill or infer consent from Click-to-WhatsApp attribution alone.
ALTER TABLE whatsapp_marketing_consent_events
  ADD COLUMN IF NOT EXISTS message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS provider_message_id TEXT,
  ADD COLUMN IF NOT EXISTS message_text TEXT,
  ADD COLUMN IF NOT EXISTS business_name TEXT,
  ADD COLUMN IF NOT EXISTS consent_scope TEXT,
  ADD COLUMN IF NOT EXISTS consent_category TEXT,
  ADD COLUMN IF NOT EXISTS consented_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS consent_method TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_marketing_consent_inbound_message
  ON whatsapp_marketing_consent_events (message_id) WHERE message_id IS NOT NULL;
