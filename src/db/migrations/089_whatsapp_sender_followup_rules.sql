-- Per-sender, clinic-authored extended follow-up plans. No default rules:
-- enabling the worker does not send a single message until operator
-- intentionally configures and approves the exact Ariel content.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS whatsapp_sender_followup_rules (
 sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
 slot_hours SMALLINT NOT NULL CHECK (slot_hours IN (2,6,20)),
 enabled BOOLEAN NOT NULL DEFAULT FALSE,
 message_text TEXT NOT NULL CHECK (LENGTH(BTRIM(message_text)) BETWEEN 3 AND 1024),
 media_key TEXT,
 media_type TEXT CHECK (media_type IS NULL OR media_type IN ('video','image','audio')),
 media_mime_type TEXT,
 media_filename TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(sender_id,slot_hours),
 CONSTRAINT whatsapp_sender_followup_media_consistent
 CHECK (
   (media_key IS NULL AND media_type IS NULL AND media_mime_type IS NULL AND media_filename IS NULL)
   OR
   (media_key IS NOT NULL AND media_type IS NOT NULL AND
    media_mime_type IS NOT NULL AND media_filename IS NOT NULL)
 )
);
CREATE TABLE IF NOT EXISTS whatsapp_sender_followup_attempts (
 id BIGSERIAL PRIMARY KEY,
 sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
 contact_id INTEGER NOT NULL,
 anchor_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
 slot_hours SMALLINT NOT NULL CHECK(slot_hours IN(2,6,20)),
 message_id INTEGER REFERENCES messages(id) ON DELETE RESTRICT,
 status TEXT NOT NULL DEFAULT 'claimed'
   CHECK(status IN('claimed','accepted','blocked','unknown')),
 wamid TEXT,
 error_code TEXT,
 claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 completed_at TIMESTAMPTZ,
 CONSTRAINT whatsapp_sender_followup_contact_owner FOREIGN KEY (contact_id,sender_id)
   REFERENCES contacts(id,whatsapp_sender_id) ON DELETE RESTRICT,
 CONSTRAINT whatsapp_sender_followup_attempt_unique UNIQUE(sender_id,contact_id,anchor_message_id,slot_hours)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_followup_attempt_contact
 ON whatsapp_sender_followup_attempts(sender_id,contact_id,claimed_at DESC);
COMMENT ON TABLE whatsapp_sender_followup_rules IS
 'Explicit sender-specific 2/6/20-hour WhatsApp followup content. Does not inherit primary Neutro followups. Marketing content must be configured only for verified sender opt-in.';
