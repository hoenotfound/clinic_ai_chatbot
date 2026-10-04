-- Store which service-specific follow-up override was selected for analytics.
-- NULL means the generic/default step message was used.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS automated_follow_up_target_service TEXT;

CREATE INDEX IF NOT EXISTS idx_messages_follow_up_step_target
  ON messages(automated_follow_up_step, automated_follow_up_target_service)
  WHERE is_automated_follow_up = true
    AND automated_follow_up_for_message_id IS NOT NULL;

COMMENT ON COLUMN messages.automated_follow_up_target_service IS
  'Canonical configured service name when a targeted automated follow-up override was used; NULL for the generic/default follow-up message.';
