-- The reservation still serializes actual dispatch. Once the provider
-- call finishes, authorized service attempts may await receipts independently.
-- Existing strict attempts stay strict until explicitly detached.
SET LOCAL lock_timeout = '3s';
ALTER TABLE whatsapp_sender_billing_attempts
  ADD COLUMN IF NOT EXISTS service_receipt_independent BOOLEAN NOT NULL DEFAULT FALSE;
COMMENT ON COLUMN whatsapp_sender_billing_attempts.service_receipt_independent IS
  'An authorized service send may retain unsettled billing evidence without holding later customer sends. Never authorizes retry or certifies no charge.';
