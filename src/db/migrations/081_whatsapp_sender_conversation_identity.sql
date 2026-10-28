-- Phase 2: sender-qualified conversation identity (additive and inactive).
-- Keep the legacy contact uniqueness constraint and every legacy message intact.
-- Do not activate second-sender customer processing until outbound, policy,
-- billing, retry and Inbox operations all use this immutable identity.
CREATE TABLE IF NOT EXISTS whatsapp_sender_conversations (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  customer_wa_id TEXT NOT NULL CHECK (customer_wa_id ~ '^[0-9]{8,15}$'),
  contact_id INTEGER UNIQUE REFERENCES contacts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'bound')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_sender_conversation_binding_consistent
    CHECK ((state = 'pending' AND contact_id IS NULL)
       OR (state = 'bound' AND contact_id IS NOT NULL)),
  CONSTRAINT whatsapp_sender_conversation_identity_unique
    UNIQUE (sender_id, customer_wa_id)
);

-- Immutable sender mapping for a saved message (never used as send authority).
CREATE TABLE IF NOT EXISTS whatsapp_sender_message_context (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL
    REFERENCES whatsapp_sender_conversations(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_message_context_conversation
  ON whatsapp_sender_message_context(conversation_id, message_id);

-- No implicit backfill: first verify the legacy Meta account and phone IDs.
-- No sender records, tokens, credentials or production flags are created.
