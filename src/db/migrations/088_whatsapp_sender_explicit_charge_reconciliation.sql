-- Phase 2 approved-charge distinction for sender-isolated Meta billing.
-- Billing authorization is attached to the exact saved staff template before
-- Graph accepts it. Never infer consent from a webhook or from a WABA alone.
SET LOCAL lock_timeout = '3s';

ALTER TABLE whatsapp_sender_billing_attempts
  ADD COLUMN billable_authorized BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE whatsapp_sender_billing_attempts
  ADD COLUMN billing_authorization_source TEXT CHECK(
    billing_authorization_source IS NULL OR
    billing_authorization_source='staff_template_billing_review'
  );

ALTER TABLE whatsapp_sender_billing_attempts
  ADD CONSTRAINT whatsapp_sender_billable_authorization_consistent
    CHECK(
      (billable_authorized=TRUE AND
       billing_authorization_source='staff_template_billing_review') OR
      (billable_authorized=FALSE AND billing_authorization_source IS NULL)
    );

ALTER TABLE whatsapp_sender_auto_reconciliations
  ADD COLUMN pricing_billable BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE whatsapp_sender_auto_reconciliations
  DROP CONSTRAINT whatsapp_sender_auto_reconciliations_method_check;

ALTER TABLE whatsapp_sender_auto_reconciliations
  ADD CONSTRAINT whatsapp_sender_auto_reconciliations_method_check
  CHECK (
    (method='signed_meta_nonbillable_free_entry' AND pricing_billable=FALSE)
    OR
    (method='signed_meta_staff_authorized_charge' AND pricing_billable=TRUE)
  );

COMMENT ON COLUMN whatsapp_sender_billing_attempts.billable_authorized IS
  'True only for an authenticated staff template message with a separately claimed one-time billing review. Signed Meta callback cannot set this authorization.';
