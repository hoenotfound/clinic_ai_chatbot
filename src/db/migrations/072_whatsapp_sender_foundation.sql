-- Multi-number WhatsApp foundation (additive only).
-- Do not activate another sender when this migration lands. Routing, outbound
-- credentials, retries, follow-ups and billing must be sender-scoped first.
-- Never store WhatsApp tokens or other credentials in this table.
CREATE TABLE IF NOT EXISTS whatsapp_sender_accounts (
  id BIGSERIAL PRIMARY KEY,
  sender_key TEXT NOT NULL UNIQUE
    CHECK (sender_key ~ '^[a-z][a-z0-9_-]{0,63}$'),
  meta_phone_number_id TEXT NOT NULL UNIQUE
    CHECK (meta_phone_number_id ~ '^[0-9]+$'),
  meta_account_id TEXT NOT NULL
    CHECK (meta_account_id ~ '^[0-9]+$'),
  display_name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'disabled'
    CHECK (state IN ('disabled', 'testing', 'active')),
  coexistence_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Nullable shadow columns preserve every historical Neutro Sense contact,
-- message, lead, outbound job, and existing ID. A later guarded migration must
-- backfill the verified existing Meta sender *before* relaxing the unique
-- contacts(whatsapp_number) constraint.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_sender_id BIGINT
    REFERENCES whatsapp_sender_accounts(id);
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS whatsapp_sender_id BIGINT
    REFERENCES whatsapp_sender_accounts(id);

CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_sender
  ON contacts(whatsapp_sender_id, whatsapp_number)
  WHERE channel = 'whatsapp';
CREATE INDEX IF NOT EXISTS idx_messages_whatsapp_sender
  ON messages(whatsapp_sender_id, contact_id, created_at DESC, id DESC)
  WHERE whatsapp_sender_id IS NOT NULL;

-- Keep contacts_whatsapp_number_key and idx_contacts_channel_user_id intact.
-- Old single-sender production behavior must not change in this foundation PR.
