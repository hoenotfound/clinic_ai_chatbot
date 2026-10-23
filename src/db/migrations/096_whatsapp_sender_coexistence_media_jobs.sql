-- Sender-owned post-ACK reconciliation for media sent from WhatsApp Business App.
-- Do not re-send these messages: provider WAMID is already accepted by Meta.
-- Jobs are immutable to a provider message and never authorize an outbound send.
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_coexistence_media_jobs (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  contact_id INTEGER NOT NULL,
  provider_media_id TEXT NOT NULL CHECK(length(provider_media_id) BETWEEN 1 AND 300),
  media_type TEXT NOT NULL CHECK(media_type IN ('image','video','audio','document','sticker')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','claimed','complete','review')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 4),
  error_code TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_sender_coexistence_media_contact_fk
    FOREIGN KEY(contact_id,sender_id) REFERENCES contacts(id,whatsapp_sender_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_coexistence_media_pending
 ON whatsapp_sender_coexistence_media_jobs(next_attempt_at,message_id)
 WHERE status='pending';
COMMENT ON TABLE whatsapp_sender_coexistence_media_jobs IS
  'Durable media FETCH ONLY for provider-authenticated WhatsApp Business App echoes; no Cloud API outbound. Review errors without replaying an outbound message.';
