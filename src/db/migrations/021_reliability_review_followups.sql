-- Move scheduled-message schema ownership into the versioned migration system
-- and add durable outbound-attempt fencing for inbound AI/system replies.

CREATE TABLE IF NOT EXISTS scheduled_messages (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'processing', 'sent', 'cancelled', 'failed', 'expired')),
  scheduled_by_username TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  claimed_at TIMESTAMPTZ,
  message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
  failure_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
  ON scheduled_messages (status, scheduled_for);

CREATE INDEX IF NOT EXISTS idx_scheduled_messages_contact
  ON scheduled_messages (contact_id, status, scheduled_for);

-- Exactly one customer-facing text dispatch may be reserved for an inbound
-- processing job. The assistant message row and this reservation are created
-- in the same transaction before the provider call. After a restart, the
-- presence of this row means the app must reconcile or hand off instead of
-- blindly generating/sending the same turn again.
CREATE TABLE IF NOT EXISTS inbound_outbound_attempts (
  processing_job_id BIGINT PRIMARY KEY
    REFERENCES inbound_processing_jobs(id) ON DELETE CASCADE,
  inbound_message_id INTEGER NOT NULL
    REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id INTEGER NOT NULL UNIQUE
    REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL
    REFERENCES contacts(id) ON DELETE CASCADE,
  origin TEXT NOT NULL
    CHECK (origin IN ('ai_reply', 'system_fallback')),
  outcome TEXT
    CHECK (outcome IS NULL OR outcome IN ('accepted', 'rejected', 'cancelled', 'ambiguous')),
  provider_message_id TEXT,
  error_text TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finalized_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbound_outbound_attempts_contact
  ON inbound_outbound_attempts (contact_id, started_at DESC);
