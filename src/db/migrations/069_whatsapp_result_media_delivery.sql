-- Reconcile the queued-media audit with the existing production CHECK constraint.
-- Applied separately from migration 068 so the existing 065 schema remains unchanged.
ALTER TABLE result_media_decisions
  DROP CONSTRAINT IF EXISTS result_media_decisions_status_check;
ALTER TABLE result_media_decisions
  ADD CONSTRAINT result_media_decisions_status_check
  CHECK (status IN ('skipped','sent','partial','failed','deferred'));

-- Provider acceptance is not customer delivery. Webhook updates set this
-- receipt state; existing 'sent' queue rows mean accepted by Meta only.
ALTER TABLE whatsapp_result_media_queue
  ADD COLUMN IF NOT EXISTS provider_delivery_status TEXT;
ALTER TABLE whatsapp_result_media_queue
  ADD CONSTRAINT whatsapp_result_media_queue_delivery_status_check
  CHECK (provider_delivery_status IS NULL OR
         provider_delivery_status IN ('sent','delivered','read','failed'));
CREATE INDEX IF NOT EXISTS idx_whatsapp_result_media_message
  ON whatsapp_result_media_queue(message_id) WHERE message_id IS NOT NULL;
