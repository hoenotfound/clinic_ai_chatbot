-- Accelerate sender-owned verified receipt and conflicting-WAMID checks.
-- Both Day4/Day6 scheduling and final Meta billing proof join on
-- (sender_id, wamid); previously only unmatched wamid_hash and reservation_id
-- were indexed. This is a read-performance index, no policy/data mutation.
--
-- The migration runner wraps migrations in a transaction, so CONCURRENTLY
-- cannot be used here. The receipt table is small (under 10k rows on
-- 2026-11-23); fail with a bounded lock wait rather than blocking live sends.
SET LOCAL lock_timeout = '8s';
SET LOCAL statement_timeout = '60s';

CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_receipts_sender_wamid
  ON whatsapp_sender_status_receipts(sender_id, wamid);
