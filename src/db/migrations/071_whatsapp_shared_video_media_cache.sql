-- Reusable outbound WhatsApp video media handles. No customer/message data is stored.
-- The unique key binds a Meta media ID to one sending phone and one immutable R2 object version.
CREATE TABLE IF NOT EXISTS whatsapp_video_media_cache (
  phone_number_id TEXT NOT NULL,
  content_fingerprint CHAR(64) NOT NULL,
  mime_type TEXT NOT NULL,
  media_id TEXT,
  expires_at TIMESTAMPTZ,
  upload_claim UUID,
  upload_claim_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (phone_number_id, content_fingerprint)
);
