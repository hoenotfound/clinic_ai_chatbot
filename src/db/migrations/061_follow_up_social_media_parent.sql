-- Link separately sent Messenger/Instagram follow-up images and videos to
-- their parent text follow-up for accurate delivery diagnostics.
-- Keep sequence trigger anchors NULL on companions: these must never
-- advance steps, block next steps, or affect idempotency.
-- Historical companions are left unlinked; timestamps alone cannot identify
-- the correct parent safely.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS automated_follow_up_parent_message_id
    INTEGER REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_messages_follow_up_media_companion_parent
  ON messages(automated_follow_up_parent_message_id)
  WHERE automated_follow_up_parent_message_id IS NOT NULL;
