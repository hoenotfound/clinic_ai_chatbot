-- Meta can explicitly mark a non-template service message free even
-- outside the paid CTWA free-entry pricing type. Never infer no charge
-- from the 24-hour reply window or a missing pricing object.
SET LOCAL lock_timeout='3s';
ALTER TABLE whatsapp_sender_auto_reconciliations
 DROP CONSTRAINT whatsapp_sender_auto_reconciliations_method_check;
ALTER TABLE whatsapp_sender_auto_reconciliations
 ADD CONSTRAINT whatsapp_sender_auto_reconciliations_method_check CHECK (
   (method IN ('signed_meta_nonbillable_free_entry',
               'signed_meta_nonbillable_customer_service') AND pricing_billable=FALSE)
   OR
   (method='signed_meta_staff_authorized_charge' AND pricing_billable=TRUE)
 );
COMMENT ON TABLE whatsapp_sender_auto_reconciliations IS
 'Exact signed Meta receipt proves free_entry_point OR free_customer_service/service was nonbillable; no future outgoing free status is inferred. Authorized charges require one-time operator confirmation.';
