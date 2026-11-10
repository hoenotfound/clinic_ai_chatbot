-- A verified Meta user_changed_* event may arrive concurrently with normal
-- messages. Keep the old BSUID as a sender-bound alias so late signed
-- messages cannot create a second lead or roll the recipient back.
-- No raw message content, profile name or phone number is stored here.
CREATE TABLE IF NOT EXISTS whatsapp_sender_user_id_aliases (
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE CASCADE,
  previous_user_id TEXT NOT NULL
    CHECK (previous_user_id ~ '^[A-Z]{2}[.][A-Za-z0-9]{1,128}$'),
  replacement_user_id TEXT NOT NULL
    CHECK (replacement_user_id ~ '^[A-Z]{2}[.][A-Za-z0-9]{1,128}$'),
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_id, previous_user_id),
  CHECK (previous_user_id <> replacement_user_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_user_id_aliases_contact
  ON whatsapp_sender_user_id_aliases (contact_id);
