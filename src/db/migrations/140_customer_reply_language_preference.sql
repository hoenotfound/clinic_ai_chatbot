-- Nullable explicit language preference; independent of consent or ownership.
-- No backfill or polling. Inbound IDs prevent stale writes.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS reply_language_preference TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS reply_language_message_id BIGINT;
