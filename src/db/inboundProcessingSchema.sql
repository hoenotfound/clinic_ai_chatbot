-- Durable reply-processing jobs for inbound customer messages.
--
-- The customer message and its processing job are inserted atomically in
-- inboundProcessingRepo.storeInboundClaim(). That means once the message is
-- visible in Postgres there is also a durable record saying whether the reply
-- work is still pending, currently processing, completed, or needs retry.
CREATE TABLE IF NOT EXISTS inbound_processing_jobs (
  id BIGSERIAL PRIMARY KEY,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'facebook', 'instagram')),
  incoming_payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'failed', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  prepared_at TIMESTAMPTZ,
  was_first_message BOOLEAN,
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbound_processing_jobs_recovery
  ON inbound_processing_jobs (status, claimed_at, created_at, id)
  WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS idx_inbound_processing_jobs_contact
  ON inbound_processing_jobs (contact_id, message_id);

CREATE INDEX IF NOT EXISTS idx_inbound_processing_jobs_completed
  ON inbound_processing_jobs (completed_at)
  WHERE status = 'completed';
