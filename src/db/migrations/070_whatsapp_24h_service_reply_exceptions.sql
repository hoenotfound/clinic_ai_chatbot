-- Separate, optional, potentially paid customer-service text reply lane.
CREATE TABLE IF NOT EXISTS whatsapp_24h_service_reply_exceptions (
  id BIGSERIAL PRIMARY KEY,
  -- Keep provider billing provenance if a contact or message is purged.
  -- The identifying foreign keys are detached, not retained.
  message_id INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  allowed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','accepted','unknown')),
  wamid TEXT UNIQUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_24h_service_reply_contact
  ON whatsapp_24h_service_reply_exceptions(contact_id,allowed_at DESC);
