-- Durable Telegram conversation-summary queue. A summary is created only after
-- the existing lead-scoring result has committed successfully. It is sent only
-- once that exact message snapshot becomes inactive, so time/message-ceiling
-- scoring cannot cause a mid-conversation Telegram alert.
CREATE TABLE IF NOT EXISTS telegram_summary_alerts (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  through_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  score_data JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'superseded', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error_text TEXT,
  claimed_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (lead_id, through_message_id)
);

CREATE INDEX IF NOT EXISTS idx_telegram_summary_alerts_pending
  ON telegram_summary_alerts(updated_at, id)
  WHERE status IN ('pending', 'sending');
