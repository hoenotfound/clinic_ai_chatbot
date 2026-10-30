-- Forward-only, offline-only audit for a specifically reviewed sender hold
-- following an authorized customer erasure. All original customer data stays
-- erased and the prior state of the original attempt stays UNKNOWN.
-- Two mutually exclusive review outcomes:
--  1. independently verified actual send & pricing evidence, or
--  2. explicitly risk-accepted UNKNOWN/UNKNOWN, without invented evidence.
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_erased_alarm_resolutions (
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  reservation_sha256 TEXT NOT NULL
    CHECK (reservation_sha256 ~ '^[a-f0-9]{64}$'),
  outcome TEXT NOT NULL CHECK (outcome IN
    ('confirmed_sent','confirmed_not_sent','unknown')),
  charge_outcome TEXT NOT NULL CHECK (charge_outcome IN
    ('charge_accounted','no_charge_verified','unknown')),
  business_app_evidence_sha256 TEXT
    CHECK (business_app_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  meta_billing_evidence_sha256 TEXT
    CHECK (meta_billing_evidence_sha256 ~ '^[a-f0-9]{64}$'),
  risk_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  signed_receipt_ingress_verified BOOLEAN NOT NULL DEFAULT FALSE,
  secondary_payment_method_verified BOOLEAN NOT NULL DEFAULT FALSE,
  original_retry_prohibited BOOLEAN NOT NULL DEFAULT TRUE
    CHECK (original_retry_prohibited = TRUE),
  reviewer TEXT NOT NULL CHECK (length(btrim(reviewer)) BETWEEN 3 AND 120),
  independent_approver TEXT NOT NULL
    CHECK (length(btrim(independent_approver)) BETWEEN 3 AND 120),
  review_reason TEXT NOT NULL
    CHECK (length(btrim(review_reason)) BETWEEN 40 AND 800),
  released_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_id, reservation_sha256),
  CHECK (lower(reviewer) <> lower(independent_approver)),
  CHECK (signed_receipt_ingress_verified AND secondary_payment_method_verified),
  CHECK (
    (outcome='unknown' AND charge_outcome='unknown'
      AND risk_accepted=TRUE
      AND business_app_evidence_sha256 IS NULL
      AND meta_billing_evidence_sha256 IS NULL)
    OR
    (outcome IN ('confirmed_sent','confirmed_not_sent')
      AND charge_outcome IN ('charge_accounted','no_charge_verified')
      AND (outcome <> 'confirmed_not_sent' OR charge_outcome='no_charge_verified')
      AND risk_accepted=FALSE
      AND business_app_evidence_sha256 IS NOT NULL
      AND meta_billing_evidence_sha256 IS NOT NULL
      AND business_app_evidence_sha256 <> meta_billing_evidence_sha256)
  )
);
COMMENT ON TABLE whatsapp_sender_erased_alarm_resolutions IS
  'Immutable audit of single erased-reservation alarm release. UNKNOWN/UNKNOWN with risk acceptance is never proof of delivery or of price; never re-send the erased message. No customer IDs, numbers, WAMIDs, or message content.';
