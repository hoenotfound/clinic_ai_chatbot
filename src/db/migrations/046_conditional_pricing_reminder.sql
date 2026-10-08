-- A conditional pricing reminder is an auxiliary automated message, not a
-- fourth sequential step. Keep it out of the three-step progress calculation.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pricing_reminder_anchor_id INTEGER REFERENCES messages(id);

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
