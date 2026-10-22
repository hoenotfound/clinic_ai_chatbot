-- Repair sender/contact integrity without changing existing customer data.
SET LOCAL lock_timeout = '3s';
ALTER TABLE whatsapp_sender_message_context
  DROP CONSTRAINT IF EXISTS whatsapp_sender_message_context_conversation_id_fkey;
ALTER TABLE whatsapp_sender_message_context
  ADD CONSTRAINT whatsapp_sender_message_context_conversation_id_fkey
  FOREIGN KEY (conversation_id) REFERENCES whatsapp_sender_conversations(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_sender_conversations
  DROP CONSTRAINT IF EXISTS whatsapp_sender_conversations_contact_id_fkey;
ALTER TABLE whatsapp_sender_conversations
  ADD CONSTRAINT whatsapp_sender_conversations_contact_id_fkey
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE;
-- Every bound sender conversation MUST match the owning contact's sender.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_id_whatsapp_sender
  ON contacts(id,whatsapp_sender_id);
DO $
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='whatsapp_sender_conversation_contact_sender_fkey'
      AND conrelid='whatsapp_sender_conversations'::regclass
  ) THEN
    ALTER TABLE whatsapp_sender_conversations
      ADD CONSTRAINT whatsapp_sender_conversation_contact_sender_fkey
      FOREIGN KEY (contact_id,sender_id)
      REFERENCES contacts(id,whatsapp_sender_id) ON DELETE CASCADE;
  END IF;
END $;
