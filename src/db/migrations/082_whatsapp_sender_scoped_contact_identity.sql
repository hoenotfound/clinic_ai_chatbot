-- Sender-scoped WhatsApp contacts. Do not enable dual-number webhooks yet.
-- Retain the legacy null-sender uniqueness guarantee and every contact ID.
-- Application code must use sender-qualified get-or-create during cutover.
SET LOCAL lock_timeout = '3s';

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_sender_id BIGINT
  REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT;

-- Build replacement uniqueness before dropping the legacy global constraint.
-- NULL sender identity continues to represent the one existing legacy Inbox.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_legacy_sender_phone
  ON contacts(whatsapp_number) WHERE whatsapp_sender_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_scoped_sender_phone
  ON contacts(whatsapp_sender_id, whatsapp_number)
  WHERE whatsapp_sender_id IS NOT NULL;

ALTER TABLE contacts DROP CONSTRAINT IF EXISTS contacts_whatsapp_number_key;

-- The old sender's numbers stay untouched and unassigned, and all prior
-- contact/message/lead references remain valid. Sender migration is explicit.
