-- Speed up per-contact/sender supersession of older queued media plans.
-- The existing unique slot index is (sender_id, inbound_message_id, sequence_no)
-- and cannot efficiently resolve successor jobs by sender and contact.
-- This index covers both active and terminal jobs: any newer media plan must
-- supersede an older pending plan, even when the newer plan has finished.
-- Applied by the versioned runner inside a transaction; no concurrent build.
SET LOCAL lock_timeout = '3s';
CREATE INDEX IF NOT EXISTS idx_sender_ai_media_contact_inbound
  ON whatsapp_sender_ai_media_jobs (sender_id, contact_id, inbound_message_id);
