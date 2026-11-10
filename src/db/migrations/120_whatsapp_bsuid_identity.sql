-- Keep the original WhatsApp address stable; the last provider-verified
-- sender address can be a number or a Meta business-scoped user ID (BSUID).
-- Never use a display username to link contacts.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_user_id TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_username TEXT,
  ADD COLUMN IF NOT EXISTS whatsapp_last_customer_address TEXT;

ALTER TABLE contacts
  ADD CONSTRAINT contacts_whatsapp_user_id_valid CHECK (
    whatsapp_user_id IS NULL OR
    whatsapp_user_id ~ '^[A-Z]{2}[.][A-Za-z0-9]{1,128}$'
  ),
  ADD CONSTRAINT contacts_whatsapp_last_customer_address_valid CHECK (
    whatsapp_last_customer_address IS NULL OR
    whatsapp_last_customer_address ~ '^([0-9]{8,15}|[A-Z]{2}[.][A-Za-z0-9]{1,128})$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS contacts_sender_whatsapp_user_id_unique
  ON contacts(whatsapp_sender_id, whatsapp_user_id)
  WHERE whatsapp_sender_id IS NOT NULL AND whatsapp_user_id IS NOT NULL;

ALTER TABLE whatsapp_sender_conversations
  DROP CONSTRAINT IF EXISTS whatsapp_sender_conversations_customer_wa_id_check;
ALTER TABLE whatsapp_sender_conversations
  ADD CONSTRAINT whatsapp_sender_conversation_customer_wa_id_check CHECK (
    customer_wa_id ~ '^([0-9]{8,15}|[A-Z]{2}[.][A-Za-z0-9]{1,128})$'
  );
