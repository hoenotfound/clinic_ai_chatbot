-- Durable retry queue for automated WhatsApp text sends that Meta explicitly
-- rejects with a known transient response. The processing_kind fence records
-- whether a provider call may have started so restart recovery never blindly
-- replays an ambiguous send.

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
    CHECK (status IN ('scheduled', 'processing', 'attention_pending', 'sent', 'failed', 'cancelled')),
  processing_kind TEXT
    CHECK (processing_kind IS NULL OR processing_kind IN ('send_pending', 'send_started', 'attention')),
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
  WHERE status IN ('scheduled', 'attention_pending');

CREATE INDEX IF NOT EXISTS idx_whatsapp_outbound_retries_processing
  ON whatsapp_outbound_retries (claimed_at, id)
  WHERE status = 'processing';
