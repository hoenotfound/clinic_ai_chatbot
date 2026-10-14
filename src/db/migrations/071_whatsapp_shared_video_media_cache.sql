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

-- Daily counters only: no patients, messages, object keys, tokens or media IDs.
CREATE TABLE IF NOT EXISTS whatsapp_video_media_cache_daily_stats (
  event_day DATE NOT NULL,
  phone_number_id TEXT NOT NULL,
  cache_hits BIGINT NOT NULL DEFAULT 0,
  cache_misses BIGINT NOT NULL DEFAULT 0,
  uploads BIGINT NOT NULL DEFAULT 0,
  fallbacks BIGINT NOT NULL DEFAULT 0,
  invalid_ids BIGINT NOT NULL DEFAULT 0,
  recovered_sends BIGINT NOT NULL DEFAULT 0,
  upload_bytes_avoided BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (event_day, phone_number_id)
);
