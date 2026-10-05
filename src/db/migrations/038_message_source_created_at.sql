-- Preserve the provider-reported time of an inbound message separately from
-- the time our server persisted it. Keep this as diagnostic/provider metadata.
-- Messaging policy windows use messages.created_at so the Inbox, backend guard
-- and visible conversation timeline all share the same durable clock.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS source_created_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_messages_contact_inbound_source_time
  ON messages (
    contact_id,
    (COALESCE(source_created_at, created_at)) DESC,
    id DESC
  )
  WHERE role = 'user';
