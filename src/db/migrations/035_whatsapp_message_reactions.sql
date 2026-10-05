-- WhatsApp reactions are metadata attached to an existing message. They must
-- never be inserted into messages as new customer turns because that would
-- affect AI replies, unread state, follow-up timers, attention, and alerts.
CREATE TABLE IF NOT EXISTS message_reactions (
  id BIGSERIAL PRIMARY KEY,
  target_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  reactor_key TEXT NOT NULL,
  emoji TEXT NOT NULL,
  provider_reaction_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (target_message_id, reactor_key)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_contact
  ON message_reactions (contact_id, target_message_id);
