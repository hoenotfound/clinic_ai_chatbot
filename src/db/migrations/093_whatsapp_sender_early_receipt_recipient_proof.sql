-- Keep a privacy-minimized recipient proof for signed Ariel status events
-- arriving before the provider acceptance transaction records their WAMID.
-- Existing receipts without this proof are deliberately not auto-promoted.
SET LOCAL lock_timeout = '3s';
ALTER TABLE whatsapp_sender_status_receipts
  ADD COLUMN recipient_hash TEXT
    CHECK (recipient_hash IS NULL OR recipient_hash ~ '^[0-9a-f]{64}$');
CREATE INDEX IF NOT EXISTS idx_sender_receipts_staged_wamid
  ON whatsapp_sender_status_receipts(sender_id,wamid_hash)
  WHERE matched=FALSE;
COMMENT ON COLUMN whatsapp_sender_status_receipts.recipient_hash IS
  'SHA256 of the HMAC-verified Meta recipient_id. Used only with exact provider WAMID and sender account when matching early receipts; never store the raw recipient.';
