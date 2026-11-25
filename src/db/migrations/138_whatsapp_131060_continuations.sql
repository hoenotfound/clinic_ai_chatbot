-- A second visible button group is subordinate to the one original inbound.
-- Never replay a claimed provider operation after process failure.
CREATE TABLE IF NOT EXISTS whatsapp_131060_continuations (
  first_message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  inbound_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  buttons JSONB NOT NULL CHECK (jsonb_typeof(buttons)='array' AND jsonb_array_length(buttons)=3),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','claimed','sent','cancelled','failed','unknown')),
  second_message_id INTEGER UNIQUE REFERENCES messages(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS whatsapp_131060_continuations_pending_idx
 ON whatsapp_131060_continuations(expires_at) WHERE state='pending';
