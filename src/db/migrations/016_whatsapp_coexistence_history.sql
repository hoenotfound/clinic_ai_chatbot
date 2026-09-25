-- WhatsApp Business App coexistence can import prior conversation history.
-- Imported rows are visible in the Inbox but are not live customer activity and
-- must not be fed into AI context or lead-scoring windows.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS is_history_import BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_messages_live_ai_history
  ON messages(contact_id, created_at DESC, id DESC)
  WHERE is_history_import = false;
