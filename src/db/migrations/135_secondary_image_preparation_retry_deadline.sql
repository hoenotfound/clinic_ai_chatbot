-- Separate preparation backoff from the ordinary billing-receipt wake.
-- NULL preserves the existing scheduling of all pending and historical jobs.
ALTER TABLE whatsapp_sender_ai_media_jobs
  ADD COLUMN IF NOT EXISTS preparation_retry_not_before TIMESTAMPTZ;
