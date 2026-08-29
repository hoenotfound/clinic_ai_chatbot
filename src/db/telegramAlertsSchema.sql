-- Durable Telegram conversation-summary queue. A summary is created only after
-- the existing lead-scoring result has committed successfully. It is sent only
-- once that exact message snapshot becomes inactive, so time/message-ceiling
-- scoring cannot cause a mid-conversation Telegram alert.
CREATE TABLE IF NOT EXISTS telegram_summary_alerts (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  through_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  score_data JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error_text TEXT,
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id, through_message_id)
);

-- Earlier versions of this feature did not have a terminal failed state. Keep
-- startup migrations safe for databases that already created the old check.
ALTER TABLE telegram_summary_alerts
  DROP CONSTRAINT IF EXISTS telegram_summary_alerts_status_check;
ALTER TABLE telegram_summary_alerts
  ADD CONSTRAINT telegram_summary_alerts_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'superseded', 'failed'));

CREATE INDEX IF NOT EXISTS idx_telegram_summary_alerts_pending
  ON telegram_summary_alerts(updated_at, id)
  WHERE status IN ('pending', 'sending');

-- Durable claims for immediate Telegram notifications. Human intervention uses
-- this table for exact-message idempotency plus a 30-minute per-contact
-- cooldown. Staff-waiting reminders use a stable event key for the first
-- unanswered customer message in an episode so only one reminder is sent even
-- when the customer sends more messages before staff replies.
CREATE TABLE IF NOT EXISTS telegram_immediate_alerts (
  id SERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  alert_type TEXT NOT NULL,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_telegram_immediate_alerts_contact
  ON telegram_immediate_alerts(contact_id, created_at DESC);
