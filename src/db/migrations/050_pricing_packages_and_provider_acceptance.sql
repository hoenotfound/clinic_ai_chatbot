-- Persist the time when the successful WhatsApp Send API response is recorded
-- (conservative timestamp: never earlier than Meta's acceptance response).
-- Historical messages remain NULL; never pretend their send time is known.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS whatsapp_accepted_at TIMESTAMPTZ;

-- A two-package pelvis offer consists of two separately audited WhatsApp
-- image messages. Each package must have at most one claim per conversation.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS pricing_reminder_package_key TEXT;

UPDATE messages
   SET pricing_reminder_package_key = 'legacy'
 WHERE pricing_reminder_anchor_id IS NOT NULL
   AND pricing_reminder_package_key IS NULL;

DROP INDEX IF EXISTS idx_messages_one_pricing_reminder_per_anchor;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_pricing_reminder_anchor_package
  ON messages(pricing_reminder_anchor_id, pricing_reminder_package_key)
  WHERE pricing_reminder_anchor_id IS NOT NULL;

ALTER TABLE messages
  ADD CONSTRAINT messages_pricing_reminder_package_key_check
  CHECK (pricing_reminder_anchor_id IS NULL OR
    (pricing_reminder_package_key IS NOT NULL AND
      length(trim(pricing_reminder_package_key)) > 0));
