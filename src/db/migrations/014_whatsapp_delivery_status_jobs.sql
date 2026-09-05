CREATE TABLE IF NOT EXISTS whatsapp_delivery_status_jobs (
  id BIGSERIAL PRIMARY KEY,
  event_key TEXT NOT NULL UNIQUE,
  wamid TEXT NOT NULL,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN ('sent', 'delivered', 'read', 'failed')),
  error_code TEXT,
  error_title TEXT,
  error_message TEXT,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'processing', 'failed', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  claimed_at TIMESTAMPTZ,
  lease_token TEXT,
  completed_at TIMESTAMPTZ,
  terminal_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_delivery_status_jobs_recovery
  ON whatsapp_delivery_status_jobs (processing_status, terminal_at, attempts, claimed_at, created_at, id)
  WHERE processing_status <> 'completed';

CREATE INDEX IF NOT EXISTS idx_whatsapp_delivery_status_jobs_wamid
  ON whatsapp_delivery_status_jobs (wamid, id);
