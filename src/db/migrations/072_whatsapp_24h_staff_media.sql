-- Add explicit staff-media provenance to audited 24-hour service exemptions.
-- Existing historical rows remain text replies.
ALTER TABLE whatsapp_24h_service_reply_exceptions
  ADD COLUMN IF NOT EXISTS send_kind TEXT NOT NULL DEFAULT 'text'
  CONSTRAINT whatsapp_24h_service_reply_send_kind_check
  CHECK (send_kind IN ('text','staff_media'));
