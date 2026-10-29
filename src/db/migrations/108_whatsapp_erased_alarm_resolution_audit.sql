-- Immutable, privacy-preserving record for a specially authorized recovery
-- of an alarm created when an unresolved sender billing attempt was erased.
-- The original customer, WAMID, message and reservation UUID remain erased.
SET LOCAL lock_timeout='3s';

CREATE TABLE IF NOT EXISTS whatsapp_sender_erased_alarm_resolutions (
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  reservation_sha256 TEXT NOT NULL
    CHECK (reservation_sha256 ~ '^[a-f0-9]{64}$'),
  outcome TEXT NOT NULL
    CHECK (outcome IN ('confirmed_sent','confirmed_not_sent')),
  charge_outcome TEXT NOT NULL
    CHECK (charge_outcome IN ('charge_accounted','no_charge_verified')),
  business_app_evidence_sha256 TEXT NOT NULL
    CHECK (business_app_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  meta_billing_evidence_sha256 TEXT NOT NULL
    CHECK (meta_billing_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  reviewer TEXT NOT NULL CHECK (length(btrim(reviewer)) BETWEEN 3 AND 120),
  independent_approver TEXT NOT NULL
    CHECK (length(btrim(independent_approver)) BETWEEN 3 AND 120),
  review_reason TEXT NOT NULL
    CHECK (length(btrim(review_reason)) BETWEEN 40 AND 800),
  released_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_id, reservation_sha256),
  CHECK (reviewer <> independent_approver),
  CHECK (business_app_evidence_sha256 <> meta_billing_evidence_sha256)
);
COMMENT ON TABLE whatsapp_sender_erased_alarm_resolutions IS
  'Irreversible audit of a two-reviewer, evidence-verified release for one privacy-purged sender alarm. No customer IDs, numbers, message bodies, WAMIDs, raw receipts or secrets.';
