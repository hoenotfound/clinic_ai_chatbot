-- Customer-data lifecycle hardening.
--
-- Contacts are the root of a customer's operational record. Historical core
-- schema left messages/leads as NO ACTION references, which makes a complete
-- privacy purge fragile because every dependent table has to be deleted in an
-- exact hand-maintained order. Convert those two root relationships to CASCADE;
-- downstream reliability, follow-up, attribution and alert tables already
-- cascade from contacts/messages/leads or use ON DELETE SET NULL where history
-- pointers may safely disappear.

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_contact_id_fkey;
ALTER TABLE messages
  ADD CONSTRAINT messages_contact_id_fkey
  FOREIGN KEY (contact_id)
  REFERENCES contacts(id)
  ON DELETE CASCADE;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_automated_follow_up_for_message_id_fkey;
ALTER TABLE messages
  ADD CONSTRAINT messages_automated_follow_up_for_message_id_fkey
  FOREIGN KEY (automated_follow_up_for_message_id)
  REFERENCES messages(id)
  ON DELETE CASCADE;

ALTER TABLE leads
  DROP CONSTRAINT IF EXISTS leads_contact_id_fkey;
ALTER TABLE leads
  ADD CONSTRAINT leads_contact_id_fkey
  FOREIGN KEY (contact_id)
  REFERENCES contacts(id)
  ON DELETE CASCADE;

-- A customer purge commits the database deletion and durable media-cleanup job
-- together. R2 cleanup is intentionally asynchronous/retryable so a temporary
-- storage outage can never force us to keep customer rows in Postgres or make
-- sensitive media cleanup best-effort only.
CREATE TABLE IF NOT EXISTS customer_data_purge_jobs (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('manual', 'retention')),
  requested_by TEXT,
  media_keys JSONB NOT NULL DEFAULT '[]'::jsonb,
  media_prefixes JSONB NOT NULL DEFAULT '[]'::jsonb,
  deleted_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  lease_token TEXT,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_data_purge_jobs_due
  ON customer_data_purge_jobs (next_attempt_at, id)
  WHERE status IN ('pending', 'failed');

CREATE INDEX IF NOT EXISTS idx_customer_data_purge_jobs_processing
  ON customer_data_purge_jobs (claimed_at, id)
  WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_customer_data_purge_jobs_contact
  ON customer_data_purge_jobs (contact_id, created_at DESC);

-- Preserve only opaque provider message identifiers long enough to reject
-- retries of customer events that were deliberately deleted. This prevents a
-- webhook retry from recreating a purged customer after the original messages
-- (and their normal dedupe keys) have been removed. New provider message IDs
-- are unaffected and may create a fresh customer journey normally.
CREATE TABLE IF NOT EXISTS customer_data_deleted_message_ids (
  provider_message_id TEXT PRIMARY KEY,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days')
);

CREATE INDEX IF NOT EXISTS idx_customer_data_deleted_message_ids_expiry
  ON customer_data_deleted_message_ids (expires_at);

CREATE TABLE IF NOT EXISTS customer_data_deleted_comment_ids (
  channel TEXT NOT NULL CHECK (channel IN ('facebook', 'instagram')),
  comment_id TEXT NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 days'),
  PRIMARY KEY (channel, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_customer_data_deleted_comment_ids_expiry
  ON customer_data_deleted_comment_ids (expires_at);
