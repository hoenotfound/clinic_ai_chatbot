-- Keep a one-shot slot reclaimable only when a documented billing gate
-- rejected it before Meta was contacted. Ambiguous or accepted sends never retry.
ALTER TABLE whatsapp_sender_followup_attempts
 DROP CONSTRAINT IF EXISTS whatsapp_sender_followup_attempts_status_check;
ALTER TABLE whatsapp_sender_followup_attempts
 ADD CONSTRAINT whatsapp_sender_followup_attempts_status_check
 CHECK(status IN ('claimed','accepted','blocked','unknown','deferred'));
ALTER TABLE whatsapp_sender_marketing_followup_attempts
 DROP CONSTRAINT IF EXISTS whatsapp_sender_marketing_followup_attempts_status_check;
ALTER TABLE whatsapp_sender_marketing_followup_attempts
 ADD CONSTRAINT whatsapp_sender_marketing_followup_attempts_status_check
 CHECK(status IN ('claimed','accepted','blocked','unknown','deferred'));
ALTER TABLE whatsapp_sender_followup_attempts
 ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS defer_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE whatsapp_sender_marketing_followup_attempts
 ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ,
 ADD COLUMN IF NOT EXISTS defer_count INTEGER NOT NULL DEFAULT 0;
