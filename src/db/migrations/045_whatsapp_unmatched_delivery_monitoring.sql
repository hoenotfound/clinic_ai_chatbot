-- Persist rare provider failures that no longer have a local saved message.
-- Do not alter delivery state or assume the missing message means no delivery.
ALTER TABLE whatsapp_delivery_status_jobs
  ADD COLUMN IF NOT EXISTS unmatched_detected_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_whatsapp_delivery_unmatched_monitor
  ON whatsapp_delivery_status_jobs (completed_at, id)
  WHERE delivery_status = 'failed'
    AND processing_status = 'completed'
    AND unmatched_detected_at IS NULL;
