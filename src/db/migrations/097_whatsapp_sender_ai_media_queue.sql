-- Separate durable automation queue for Ariel's approved Neutro treatment
-- graphics. The original Neutro media queue and strict RM0 worker are not touched.
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_ai_media_jobs (
 id BIGSERIAL PRIMARY KEY,
 sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
 contact_id INTEGER NOT NULL,
 inbound_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
 sequence_no INTEGER NOT NULL CHECK(sequence_no BETWEEN 0 AND 4),
 media_kind TEXT NOT NULL CHECK(media_kind IN ('promotion','result')),
 image_url TEXT NOT NULL CHECK(length(image_url) BETWEEN 8 AND 2048),
 caption TEXT NOT NULL DEFAULT '' CHECK(length(caption)<=1024),
 state TEXT NOT NULL DEFAULT 'pending'
   CHECK(state IN ('pending','claimed','accepted','unknown','expired')),
 outbound_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
 accepted_wamid TEXT,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 expires_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 CONSTRAINT whatsapp_sender_ai_media_contact_fk
   FOREIGN KEY(contact_id,sender_id) REFERENCES contacts(id,whatsapp_sender_id)
   ON DELETE CASCADE,
 CONSTRAINT whatsapp_sender_ai_media_one_slot
   UNIQUE(sender_id,inbound_message_id,sequence_no)
);
CREATE INDEX IF NOT EXISTS idx_sender_ai_media_pending
 ON whatsapp_sender_ai_media_jobs(next_attempt_at,id) WHERE state='pending';
COMMENT ON TABLE whatsapp_sender_ai_media_jobs IS
 'Sender-qualified one-shot deferred promotional/result images. Claimed/unknown jobs are never automatically retried after a possible Meta provider send.';
