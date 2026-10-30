-- Permanently classify Business App history/contact-sync contacts as manual.
-- Forward-only, no automation is activated, never changes contact ownership.
SET LOCAL lock_timeout = '3s';
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_coexistence_imported_at TIMESTAMPTZ;
-- Backfill historical messages already imported. Contact-only records created
-- before the explicitly future ads-only activation are excluded by created_at.
UPDATE contacts c SET whatsapp_coexistence_imported_at = NOW()
WHERE c.whatsapp_coexistence_imported_at IS NULL
  AND EXISTS (
    SELECT 1 FROM whatsapp_sender_coexistence_history_messages h
    JOIN messages m ON m.id=h.message_id
    WHERE m.contact_id=c.id
  );
