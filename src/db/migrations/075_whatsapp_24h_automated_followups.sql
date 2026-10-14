-- Extend the existing audited, one-shot 24-hour service-message exception
-- only for explicitly opted-in automated follow-up text and media.
-- Preserve all historical send kinds and their provider/billing provenance.
ALTER TABLE whatsapp_24h_service_reply_exceptions
  DROP CONSTRAINT IF EXISTS whatsapp_24h_service_reply_send_kind_check;
ALTER TABLE whatsapp_24h_service_reply_exceptions
  ADD CONSTRAINT whatsapp_24h_service_reply_send_kind_check
  CHECK (send_kind IN ('text','staff_media','auto_followup_text','auto_followup_media'));
