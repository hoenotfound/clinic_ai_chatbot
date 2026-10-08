-- A conditional pricing reminder is an auxiliary automated message, not a
-- fourth sequential step. Keep it out of the three-step progress calculation.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pricing_reminder_anchor_id INTEGER REFERENCES messages(id) ON DELETE CASCADE;

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_automated_follow_up_step_check;
ALTER TABLE messages ADD CONSTRAINT messages_automated_follow_up_step_check
  CHECK (automated_follow_up_step BETWEEN 1 AND 4);

ALTER TABLE messages ADD CONSTRAINT messages_pricing_reminder_shape_check
  CHECK (
    pricing_reminder_anchor_id IS NULL OR
    (is_automated_follow_up = true AND automated_follow_up_step = 4
      AND automated_follow_up_for_message_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_one_pricing_reminder_per_anchor
  ON messages(pricing_reminder_anchor_id)
  WHERE pricing_reminder_anchor_id IS NOT NULL;

-- Durable decisions make skips and human-review cases visible in analytics
-- and prevent repeating the same alert every sweep.
CREATE TABLE IF NOT EXISTS pricing_reminder_decisions (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  anchor_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  reason TEXT NOT NULL CHECK (reason IN (
    'already_sent', 'delivery_review', 'ambiguous_service',
    'ambiguous_package', 'missing_promotion', 'insufficient_window'
  )),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pricing_reminder_decisions_created
  ON pricing_reminder_decisions(created_at, reason);
