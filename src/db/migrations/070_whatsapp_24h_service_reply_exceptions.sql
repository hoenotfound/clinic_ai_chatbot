-- Separate, optional, potentially paid customer-service text reply lane.
CREATE TABLE IF NOT EXISTS whatsapp_24h_service_reply_exceptions (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  allowed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','accepted','unknown')),
  wamid TEXT UNIQUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_24h_service_reply_contact
  ON whatsapp_24h_service_reply_exceptions(contact_id,allowed_at DESC);
