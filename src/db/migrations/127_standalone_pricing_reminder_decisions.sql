-- Isolated, bounded audit for the opt-in standalone price reminder.
-- The legacy pricing_reminder_decisions table has an immutable single-reason
-- constraint and must not be reused for independent delivery events.
CREATE TABLE IF NOT EXISTS standalone_pricing_reminder_decisions (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  inbound_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contact_id, inbound_message_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_standalone_pricing_decisions_created
  ON standalone_pricing_reminder_decisions(created_at DESC);
