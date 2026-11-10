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

-- Primary sender lookup can be sender-scoped or a legacy untagged contact.
-- Keep this small partial index for direct BSUID lookup without a full scan.
CREATE INDEX IF NOT EXISTS contacts_whatsapp_user_id_lookup
  ON contacts(whatsapp_user_id)
  WHERE whatsapp_user_id IS NOT NULL;

ALTER TABLE whatsapp_sender_conversations
  DROP CONSTRAINT IF EXISTS whatsapp_sender_conversations_customer_wa_id_check;
ALTER TABLE whatsapp_sender_conversations
  ADD CONSTRAINT whatsapp_sender_conversation_customer_wa_id_check CHECK (
    customer_wa_id ~ '^([0-9]{8,15}|[A-Z]{2}[.][A-Za-z0-9]{1,128})$'
  );

-- The transport recipient must be frozen on each billing reservation. A
-- later inbound can change a contact's last address while an earlier Meta
-- delivery receipt is still in flight.
ALTER TABLE whatsapp_sender_billing_attempts
  ADD COLUMN IF NOT EXISTS recipient_address TEXT;
ALTER TABLE whatsapp_sender_billing_attempts
  ADD CONSTRAINT whatsapp_sender_billing_recipient_address_check CHECK (
    recipient_address IS NULL OR
    recipient_address ~ '^([0-9]{8,15}|[A-Z]{2}[.][A-Za-z0-9]{1,128})$'
  );

-- A signed delivery may contain both recipient_id and recipient_user_id
-- before local HTTP acceptance is saved. Keep the second SHA256-only address
-- for exact reservation matching; do not infer a customer from WAMID alone.
ALTER TABLE whatsapp_sender_status_receipts
  ADD COLUMN IF NOT EXISTS alternate_recipient_hash TEXT;
ALTER TABLE whatsapp_sender_status_receipts
  ADD CONSTRAINT whatsapp_sender_receipt_alternate_hash_check CHECK (
    alternate_recipient_hash IS NULL OR
    alternate_recipient_hash ~ '^[a-f0-9]{64}$'
  );
