-- Provider-authenticated customer edit/revoke events modify existing messages.
-- Keep out-of-order events durable without pretending they are new customer turns.
SET LOCAL lock_timeout = '3s';

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS whatsapp_customer_mutation TEXT
    CHECK (whatsapp_customer_mutation IN ('edit','revoke','edit_unavailable','unavailable_edit'));
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS whatsapp_customer_mutated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS whatsapp_customer_message_mutations (
  event_wamid TEXT PRIMARY KEY CHECK (length(event_wamid) BETWEEN 6 AND 512),
  target_wamid TEXT CHECK (target_wamid IS NULL OR length(target_wamid) BETWEEN 6 AND 512),
  business_phone_number_id TEXT NOT NULL,
  business_account_id TEXT NOT NULL,
  -- Identifier is needed only until the event can be matched. Clear it
  -- after applying and cascade resolved events when the contact is erased.
  customer_address TEXT,
  customer_user_id TEXT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('edit','revoke','edit_unavailable','unavailable_edit')),
  replacement_text TEXT CHECK (replacement_text IS NULL OR length(replacement_text) <= 4096),
  provider_timestamp BIGINT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied')),
  target_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  notice_contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT customer_mutation_target_required CHECK (
    (action = 'unavailable_edit' AND target_wamid IS NULL) OR
    (action <> 'unavailable_edit' AND target_wamid IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_customer_mutations_pending
  ON whatsapp_customer_message_mutations (target_wamid, provider_timestamp, event_wamid)
  WHERE status = 'pending' AND target_wamid IS NOT NULL;
COMMENT ON TABLE whatsapp_customer_message_mutations IS
  'Customer edit/delete event ledger. Does not create inbound AI turns or grant marketing consent.';
