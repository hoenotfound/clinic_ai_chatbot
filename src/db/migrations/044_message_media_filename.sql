-- Preserve the original client-visible filename for stored message attachments.
-- Existing media remains valid with a NULL filename and falls back to a generic name.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_filename TEXT;
