-- Channel-specific customer identifier used by Facebook Messenger (PSID) and
-- Instagram Messaging (IGSID). WhatsApp keeps using whatsapp_number exactly as
-- before; the backfill is informational and does not change its identity key.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS channel_user_id TEXT;

UPDATE contacts
SET channel_user_id = whatsapp_number
WHERE channel = 'whatsapp'
  AND channel_user_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_channel_user_id
  ON contacts(channel, channel_user_id)
  WHERE channel_user_id IS NOT NULL;
