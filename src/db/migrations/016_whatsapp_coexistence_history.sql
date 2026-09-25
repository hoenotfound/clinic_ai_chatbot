-- WhatsApp Business App coexistence can import prior conversation history.
-- Imported rows are visible in the Inbox but are not live customer activity and
-- must not be fed into AI context or lead-scoring windows.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_history_import BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_messages_live_ai_history
  ON messages(contact_id, created_at DESC, id DESC)
  WHERE is_history_import = false;

-- History sync webhooks can contain large chunks and Meta may retry them.
-- Persist each chunk before acknowledging the webhook, then import it through
-- a lease-fenced recovery worker so a Render restart cannot silently lose it.
CREATE TABLE IF NOT EXISTS whatsapp_coexistence_history_jobs (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_at TIMESTAMPTZ,
  lease_token TEXT,
  completed_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_coexistence_history_jobs_recovery
  ON whatsapp_coexistence_history_jobs(processing_status, updated_at, id)
  WHERE terminal_at IS NULL AND processing_status <> 'completed';
