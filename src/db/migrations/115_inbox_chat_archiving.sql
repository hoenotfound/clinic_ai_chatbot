-- Staff-only Inbox archive state. This is independent of AI, lead status,
-- WhatsApp policy, opt-in, unread and automated follow-up scheduling.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS inbox_archived_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_contacts_inbox_archived
  ON contacts (inbox_archived_at DESC, id)
  WHERE inbox_archived_at IS NOT NULL;

-- Restore archived chats on a genuinely newer inbound message, regardless
-- of channel or sender. Old Coexistence/history imports must not reopen
-- a chat that staff intentionally archived after the original message.
-- Trigger adds zero periodic database work and fires for all inbound writers.
CREATE OR REPLACE FUNCTION restore_inbox_archive_on_inbound()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  UPDATE contacts
  SET inbox_archived_at = NULL
  WHERE id = NEW.contact_id
    AND inbox_archived_at IS NOT NULL
    AND NEW.created_at >= inbox_archived_at
    AND COALESCE(NEW.source_created_at, NEW.created_at) >= inbox_archived_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_restore_inbox_archive_on_inbound ON messages;
CREATE TRIGGER trg_restore_inbox_archive_on_inbound
AFTER INSERT ON messages
FOR EACH ROW
WHEN (NEW.role = 'user')
EXECUTE FUNCTION restore_inbox_archive_on_inbound();
