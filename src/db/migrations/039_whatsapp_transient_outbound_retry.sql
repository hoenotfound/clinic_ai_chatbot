-- Durable retry queue for automated WhatsApp text sends that Meta explicitly
-- rejects with a transient response. Processing rows are never blindly replayed
-- after a worker crash because delivery may already have reached Meta.

CREATE TABLE IF NOT EXISTS whatsapp_outbound_retries (
  id BIGSERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL UNIQUE
    REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL
    REFERENCES contacts(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL,
  origin TEXT NOT NULL
    CHECK (origin IN ('ai_reply', 'system_fallback')),
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'processing', 'sent', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  claimed_at TIMESTAMPTZ,
  lease_token TEXT,
  last_error TEXT,
  provider_status INTEGER,
  provider_error_code INTEGER,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_retries_due
  ON whatsapp_outbound_retries (next_attempt_at, id)
  WHERE status = 'scheduled';

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_retries_processing
  ON whatsapp_outbound_retries (claimed_at, id)
  WHERE status = 'processing';
