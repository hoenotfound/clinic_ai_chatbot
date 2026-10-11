-- Internal per-inbound result-image decision trail. No customer-visible copy.
-- Keeps the reason even when automatic image media is deliberately skipped.
CREATE TABLE IF NOT EXISTS result_media_decisions (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  inbound_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('skipped', 'sent', 'partial', 'failed')),
  reason TEXT,
  promotion_images_sent INTEGER NOT NULL DEFAULT 0,
  result_images_selected INTEGER NOT NULL DEFAULT 0,
  result_images_sent INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_result_media_decisions_contact_created
  ON result_media_decisions (contact_id, created_at DESC);
