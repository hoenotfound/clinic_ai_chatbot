-- Allow up to three automated follow-up steps for one unanswered conversation.
-- The existing trigger-message column remains the stable conversation anchor.
-- A step number makes the idempotency key (anchor, step) instead of just anchor.
--
-- DEFAULT 1 keeps rolling deploys safe: an older app version that inserts an
-- automated follow-up without naming this column still claims step 1, and the
-- new composite unique index continues to prevent duplicate sends.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS automated_follow_up_step INTEGER NOT NULL DEFAULT 1;

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_automated_follow_up_step_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_automated_follow_up_step_check
  CHECK (automated_follow_up_step BETWEEN 1 AND 3);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_one_automated_follow_up_per_trigger_step
  ON messages(automated_follow_up_for_message_id, automated_follow_up_step)
  WHERE automated_follow_up_for_message_id IS NOT NULL;

DROP INDEX IF EXISTS idx_messages_one_automated_follow_up_per_trigger;

CREATE INDEX IF NOT EXISTS idx_messages_automated_follow_up_progress
  ON messages(automated_follow_up_for_message_id, automated_follow_up_step)
  WHERE is_automated_follow_up = true
    AND automated_follow_up_for_message_id IS NOT NULL;

COMMENT ON COLUMN messages.automated_follow_up_step IS
  '1-based automated follow-up sequence step. Together with automated_follow_up_for_message_id it forms the durable idempotency key for one unanswered conversation cycle.';
