-- Optional WhatsApp result images wait for confirmed RM0 pricing off the customer reply path.
-- A crashed/ambiguous provider send is NEVER automatically replayed.
CREATE TABLE IF NOT EXISTS whatsapp_result_media_queue (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  inbound_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  sequence_no INTEGER NOT NULL CHECK (sequence_no BETWEEN 0 AND 4),
  media_kind TEXT NOT NULL DEFAULT 'result' CHECK (media_kind IN ('result','promotion')),
  image_url TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','sent','skipped','cancelled','failed','unknown')),
  message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  lease_token UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (inbound_message_id, sequence_no)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_result_media_due
  ON whatsapp_result_media_queue(next_attempt_at,id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_whatsapp_result_media_contact
  ON whatsapp_result_media_queue(contact_id,created_at DESC);
