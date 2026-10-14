-- Link an active delivery-only attention task to the exact failed outbound
-- attempt. Old delivery attempts remain in messages for auditing, but must
-- never be confused with a newer failed photo in another customer episode.
-- NULL means legacy/unlinked attention; preserve its conservative handling.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS delivery_attention_message_id INTEGER
  REFERENCES messages(id) ON DELETE SET NULL;

COMMENT ON COLUMN contacts.delivery_attention_message_id IS
  'Message id behind the currently visible delivery attention warning. NULL for legacy or non-message attention; cleared only by explicit resolution or safe reply reconciliation.';
