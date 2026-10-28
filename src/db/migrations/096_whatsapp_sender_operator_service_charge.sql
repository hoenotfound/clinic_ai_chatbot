-- Ariel operator-approved service-message charges are different from a
-- one-time staff-approved marketing/utility template. Retain both proofs.
-- No data updates, no primary Neutro billing changes and no automatic consent.
SET LOCAL lock_timeout = '3s';
ALTER TABLE whatsapp_sender_billing_attempts
  DROP CONSTRAINT whatsapp_sender_billable_authorization_consistent;
ALTER TABLE whatsapp_sender_billing_attempts
  ADD CONSTRAINT whatsapp_sender_billable_authorization_consistent CHECK (
    (billable_authorized = TRUE AND (
      (billing_authorization_source = 'staff_template_billing_review'
       AND billing_review_claim_hash IS NOT NULL)
      OR
      (billing_authorization_source = 'operator_acknowledged_service'
       AND billing_review_claim_hash IS NULL)
    ))
    OR
    (billable_authorized = FALSE AND
     billing_authorization_source IS NULL AND
     billing_review_claim_hash IS NULL)
  );
ALTER TABLE whatsapp_sender_auto_reconciliations
  DROP CONSTRAINT whatsapp_sender_auto_reconciliations_method_check;
ALTER TABLE whatsapp_sender_auto_reconciliations
  ADD CONSTRAINT whatsapp_sender_auto_reconciliations_method_check CHECK (
    (method IN ('signed_meta_nonbillable_free_entry',
                'signed_meta_nonbillable_customer_service') AND pricing_billable=FALSE)
    OR
    (method IN ('signed_meta_staff_authorized_charge',
                'signed_meta_operator_authorized_service_charge') AND pricing_billable=TRUE)
  );
COMMENT ON COLUMN whatsapp_sender_billing_attempts.billable_authorized IS
  'Per-attempt provenance: staff one-time template charge review OR explicit sender operator authorization for a service-window freeform send. Never inferred from the 24-hour window.';
