-- Secondary-sender-only post-window MARKETING template followups.
-- No default active rules, no historical consent backfill, no provider calls.
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_marketing_followup_rules (
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  slot_hours SMALLINT NOT NULL CHECK(slot_hours IN (48,72)),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  template_name TEXT NOT NULL CHECK(template_name ~ '^[a-z0-9_]{1,128}$'),
  language_code TEXT NOT NULL CHECK(language_code ~ '^[a-z]{2,3}(_[A-Z]{2})?$'),
  template_signature TEXT NOT NULL CHECK(template_signature ~ '^[a-f0-9]{64}$'),
  operator_billing_approved BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(sender_id,slot_hours),
  CHECK(enabled = FALSE OR operator_billing_approved = TRUE)
);
CREATE TABLE IF NOT EXISTS whatsapp_sender_marketing_followup_attempts (
  id BIGSERIAL PRIMARY KEY,
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  contact_id INTEGER NOT NULL,
  anchor_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
  slot_hours SMALLINT NOT NULL CHECK(slot_hours IN (48,72)),
  message_id INTEGER REFERENCES messages(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'claimed'
    CHECK(status IN('claimed','accepted','blocked','unknown')),
  wamid TEXT,
  error_code TEXT,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT whatsapp_sender_marketing_attempt_owner
    FOREIGN KEY(contact_id,sender_id) REFERENCES contacts(id,whatsapp_sender_id)
    ON DELETE RESTRICT,
  UNIQUE(sender_id,contact_id,anchor_message_id,slot_hours)
);
CREATE INDEX IF NOT EXISTS idx_sender_marketing_attempt_recent
  ON whatsapp_sender_marketing_followup_attempts(sender_id,contact_id,claimed_at DESC);

-- A separately approved automated marketing template charge is neither
-- a staff review nor a service-window operator authorization. Preserve that
-- distinction in the per-attempt billing audit.
ALTER TABLE whatsapp_sender_billing_attempts
 DROP CONSTRAINT whatsapp_sender_billable_authorization_consistent;
ALTER TABLE whatsapp_sender_billing_attempts
 ADD CONSTRAINT whatsapp_sender_billable_authorization_consistent CHECK (
   (billable_authorized=TRUE AND (
     (billing_authorization_source='staff_template_billing_review'
       AND billing_review_claim_hash IS NOT NULL) OR
     (billing_authorization_source='operator_acknowledged_service'
       AND billing_review_claim_hash IS NULL) OR
     (billing_authorization_source='operator_approved_marketing_template'
       AND billing_review_claim_hash IS NULL)
   )) OR
   (billable_authorized=FALSE AND billing_authorization_source IS NULL
      AND billing_review_claim_hash IS NULL)
 );
ALTER TABLE whatsapp_sender_auto_reconciliations
 DROP CONSTRAINT whatsapp_sender_auto_reconciliations_method_check;
ALTER TABLE whatsapp_sender_auto_reconciliations
 ADD CONSTRAINT whatsapp_sender_auto_reconciliations_method_check CHECK (
   (method IN('signed_meta_nonbillable_free_entry',
      'signed_meta_nonbillable_customer_service') AND pricing_billable=FALSE)
   OR (method IN('signed_meta_staff_authorized_charge',
      'signed_meta_operator_authorized_service_charge',
      'signed_meta_operator_approved_marketing_template') AND pricing_billable=TRUE)
 );
