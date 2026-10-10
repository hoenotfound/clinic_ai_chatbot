-- Pricing reminder reconciliation reads historical Messenger/Instagram
-- caption/image acceptance evidence by message and channel.
-- Keep the existing provider_message_id PK and contact lookups intact.
CREATE INDEX IF NOT EXISTS idx_social_provider_message_ids_message_channel
  ON social_provider_message_ids (message_id, channel, provider_message_id);
