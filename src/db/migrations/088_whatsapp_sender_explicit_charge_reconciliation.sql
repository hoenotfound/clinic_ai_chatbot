-- Phase 2: sender-specific approved template charges and one-time staff review.
-- Additive migration; no existing primary Neutro gate is modified.
SET LOCAL lock_timeout = '3s';

ALTER TABLE whatsapp_sender_billing_attempts
  ADD COLUMN billable_authorized BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE whatsapp_sender_billing_attempts
  ADD COLUMN billing_review_claim_hash TEXT UNIQUE;

ALTER TABLE whatsapp_sender_billing_attempts
  ADD CONSTRAINT whatsapp_sender_billing_review_hash_valid
  CHECK (
    billing_review_claim_hash IS NULL OR
    (LENGTH(billing_review_claim_hash) = 64 AND
     billing_review_claim_hash !~ '[^a-f0-9]')
  );

ALTER TABLE whatsapp_sender_billing_attempts
  ADD COLUMN billing_authorization_source TEXT;

ALTER TABLE whatsapp_sender_billing_attempts
  ADD CONSTRAINT whatsapp_sender_billable_authorization_consistent
  CHECK (
    (billable_authorized = TRUE AND
     billing_authorization_source = 'staff_template_billing_review' AND
     billing_review_claim_hash IS NOT NULL)
    OR
    (billable_authorized = FALSE AND
     billing_authorization_source IS NULL AND
     billing_review_claim_hash IS NULL)
  );

ALTER TABLE whatsapp_sender_auto_reconciliations
  ADD COLUMN pricing_billable BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE whatsapp_sender_auto_reconciliations
  DROP CONSTRAINT whatsapp_sender_auto_reconciliations_method_check;

ALTER TABLE whatsapp_sender_auto_reconciliations
  ADD CONSTRAINT whatsapp_sender_auto_reconciliations_method_check
  CHECK (
    (method = 'signed_meta_nonbillable_free_entry' AND pricing_billable = FALSE)
    OR
    (method = 'signed_meta_staff_authorized_charge' AND pricing_billable = TRUE)
  );

COMMENT ON COLUMN whatsapp_sender_billing_attempts.billable_authorized IS
  'True only after the exact sender-bound staff template saved a claimed, one-time billing review.';
