-- Preserve the provider-reported time of an inbound message separately from
-- the time our server persisted it. This keeps operational ordering/recovery on
-- messages.created_at while allowing channel policy windows to use the actual
-- customer send time when Meta supplies one.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_contact_inbound_source_time
  ON messages (
    contact_id,
    (COALESCE(source_created_at, created_at)) DESC,
    id DESC
  )
  WHERE role = 'user';
