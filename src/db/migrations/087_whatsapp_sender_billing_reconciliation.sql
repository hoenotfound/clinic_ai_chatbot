-- Phase 2D: persistent secondary-sender billing alarms and manual reconciliation audit.
-- Does not modify legacy WhatsApp data or install a public operator endpoint.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS whatsapp_sender_billing_alarms (
  sender_id BIGINT PRIMARY KEY REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  reservation_id UUID NOT NULL REFERENCES whatsapp_sender_billing_attempts(reservation_id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('provider_billable','provider_delivery_failed')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  observed_count INTEGER NOT NULL DEFAULT 1 CHECK (observed_count >= 1),
  latest_wamid_hash TEXT NOT NULL CHECK (latest_wamid_hash ~ '^[a-f0-9]{64}$')
);
COMMENT ON TABLE whatsapp_sender_billing_alarms IS
  'Fail-closed sender-level hold for adverse Meta receipts, including late receipts for settled sends. There is no automated unlock.';

CREATE TABLE IF NOT EXISTS whatsapp_sender_billing_reconciliations (
  reservation_id UUID PRIMARY KEY REFERENCES whatsapp_sender_billing_attempts(reservation_id) ON DELETE RESTRICT,
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  provider_receipt_fingerprint TEXT NOT NULL
    REFERENCES whatsapp_sender_status_receipts(fingerprint) ON DELETE RESTRICT,
  reviewer TEXT NOT NULL CHECK (LENGTH(BTRIM(reviewer)) BETWEEN 3 AND 128),
  reason TEXT NOT NULL CHECK (LENGTH(BTRIM(reason)) BETWEEN 12 AND 1000),
  billing_hub_confirmed BOOLEAN NOT NULL CHECK (billing_hub_confirmed = TRUE),
  reconciled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_sender_billing_reconciliation_owned_attempt
    FOREIGN KEY (reservation_id, sender_id)
    REFERENCES whatsapp_sender_billing_attempts(reservation_id, sender_id)
    ON DELETE RESTRICT
);
COMMENT ON TABLE whatsapp_sender_billing_reconciliations IS
  'Audited manual reconciliation after signed nonbillable Meta evidence and separately checked Billing Hub; never authorizes a send by itself.';
