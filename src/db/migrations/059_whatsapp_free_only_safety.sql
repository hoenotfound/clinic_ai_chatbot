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
  message_id INTEGER,
  attempt_id BIGINT,
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

-- An operator can release an ambiguous slot only after explicitly reviewing
-- the WhatsApp conversation and Meta Billing Hub. Keep immutable audit trails.
CREATE TABLE IF NOT EXISTS whatsapp_free_only_reconciliations (
  id BIGSERIAL PRIMARY KEY,
  phone_number_id TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  prior_status TEXT NOT NULL,
  wamid TEXT,
  message_id INTEGER,
  attempt_id BIGINT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  verified_billing_hub BOOLEAN NOT NULL,
  provider_pricing_type TEXT,
  provider_billable BOOLEAN,
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_free_only_reconciliations_account
  ON whatsapp_free_only_reconciliations(phone_number_id, reconciled_at DESC);
