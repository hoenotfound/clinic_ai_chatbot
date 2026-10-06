-- WhatsApp-style Inbox message actions.
-- reply_to_provider_message_id keeps the original provider message reference so
-- quoted replies can be rendered without copying stale message text.
-- is_forwarded is an Inbox/audit marker for content resent through Forward.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS reply_to_provider_message_id TEXT;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_forwarded BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_messages_reply_to_provider_message_id
  ON messages (reply_to_provider_message_id)
  WHERE reply_to_provider_message_id IS NOT NULL;
