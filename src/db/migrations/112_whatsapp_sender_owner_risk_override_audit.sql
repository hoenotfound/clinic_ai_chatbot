-- Preserve the explicit owner-authorized, one-time historical billing-risk
-- exception without forging independently verified reviewer approval.
-- Old delivery, Meta charges, and signed status receipt on current deploy
-- remain unverified. This audit cannot authorize any sends or retries.
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_owner_risk_override_audit (
 sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
 alarm_reservation_sha256 TEXT NOT NULL
   CHECK (alarm_reservation_sha256 ~ '^[a-f0-9]{64}$'),
 historical_reservation_hashes TEXT[] NOT NULL
   CHECK (cardinality(historical_reservation_hashes)=2),
 delivery_outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (delivery_outcome='unknown'),
 charge_outcome TEXT NOT NULL DEFAULT 'unknown' CHECK (charge_outcome='unknown'),
 owner_authorized BOOLEAN NOT NULL CHECK (owner_authorized),
 partner_approval_owner_relayed BOOLEAN NOT NULL CHECK (partner_approval_owner_relayed),
 partner_independently_verified BOOLEAN NOT NULL DEFAULT FALSE
   CHECK (partner_independently_verified=FALSE),
 signed_receipt_on_current_deploy_verified BOOLEAN NOT NULL DEFAULT FALSE
   CHECK (signed_receipt_on_current_deploy_verified=FALSE),
 possible_future_charge_accepted BOOLEAN NOT NULL CHECK (possible_future_charge_accepted),
 old_message_retry_prohibited BOOLEAN NOT NULL CHECK (old_message_retry_prohibited),
 override_reason TEXT NOT NULL,
 commit_sha TEXT NOT NULL,
 authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(sender_id,alarm_reservation_sha256)
);
COMMENT ON TABLE whatsapp_sender_owner_risk_override_audit IS
 'Single owner-directed override for pre-existing erased UNKNOWN alarm. Keep old audit, do not retry old messages or claim independent review/delivery/billing proof. No automatic send authorization.';
DO $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgname='trg_whatsapp_sender_owner_override_append_only'
    AND tgrelid='whatsapp_sender_owner_risk_override_audit'::regclass) THEN
   EXECUTE 'CREATE TRIGGER trg_whatsapp_sender_owner_override_append_only
     BEFORE UPDATE OR DELETE ON whatsapp_sender_owner_risk_override_audit
     FOR EACH ROW EXECUTE FUNCTION reject_erased_alarm_resolution_mutation()';
 END IF;
END $$;
