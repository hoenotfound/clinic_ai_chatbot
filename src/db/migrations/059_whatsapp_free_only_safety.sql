-- A single durable, account-scoped outbound reservation prevents a second
-- strict-mode send until Meta prices the previous one. Ambiguous sends remain
-- blocked across processes and restarts; they must never time out open.
CREATE TABLE IF NOT EXISTS whatsapp_free_only_send_gate (
  phone_number_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'idle'
    CHECK (status IN ('idle','reserved','awaiting_pricing','unknown')),
  reservation_id TEXT,
  wamid TEXT,
  recipient TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'idle' OR reservation_id IS NULL)
);

-- Aggregate blocks by hour rather than filling Neon with repetitive per-send logs.
CREATE TABLE IF NOT EXISTS whatsapp_free_only_block_events (
  phone_number_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  hour_bucket TIMESTAMPTZ NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  last_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (phone_number_id, reason, hour_bucket)
);

CREATE TABLE IF NOT EXISTS whatsapp_free_only_billing_alerts (
  wamid TEXT PRIMARY KEY,
  phone_number_id TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TIMESTAMPTZ,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_free_only_billing_unsent
  ON whatsapp_free_only_billing_alerts(observed_at)
  WHERE sent_at IS NULL;
