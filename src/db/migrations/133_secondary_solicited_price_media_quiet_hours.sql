-- Do not reclassify existing pending media. Only newly authorized price
-- artwork can opt out of the media worker's night-time pause.
SET LOCAL lock_timeout = '3s';
ALTER TABLE whatsapp_sender_ai_media_jobs
  ADD COLUMN IF NOT EXISTS solicited_pricing BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE whatsapp_sender_ai_media_jobs
  ADD CONSTRAINT chk_secondary_solicited_price_promotion_only
  CHECK (NOT solicited_pricing OR media_kind='promotion');
COMMENT ON COLUMN whatsapp_sender_ai_media_jobs.solicited_pricing IS
  'Verified customer-requested price artwork only; not unsolicited promotions, Before/After images or scheduled follow-ups.';
