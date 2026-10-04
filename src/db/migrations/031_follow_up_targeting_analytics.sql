-- Store service-targeting metadata for follow-up analytics.
-- Existing automated follow-ups remain untracked so analytics can label them
-- as legacy/unknown instead of incorrectly counting them as General.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS automated_follow_up_target_service TEXT;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS automated_follow_up_targeting_recorded BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_messages_follow_up_step_target
  ON messages(
    automated_follow_up_step,
    automated_follow_up_targeting_recorded,
    automated_follow_up_target_service
  )
  WHERE is_automated_follow_up = true
    AND automated_follow_up_for_message_id IS NOT NULL;

COMMENT ON COLUMN messages.automated_follow_up_target_service IS
  'Canonical configured service name when a targeted automated follow-up override was used; NULL for general or legacy/untracked follow-ups.';

COMMENT ON COLUMN messages.automated_follow_up_targeting_recorded IS
  'True when the follow-up sender explicitly recorded whether this send was general or service-targeted; false for legacy rows created before targeting analytics.';
