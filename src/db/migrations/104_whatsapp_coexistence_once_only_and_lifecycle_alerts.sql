-- PR395 additive, QA-first once-only sync dispatch and legacy lifecycle alerts.
-- No writes to legacy customer, message, sender or production billing tables.
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS whatsapp_coexistence_sync_dispatch_requests (
 id BIGSERIAL PRIMARY KEY,
 onboarding_attempt_id BIGINT NOT NULL REFERENCES whatsapp_coexistence_onboarding_attempts(id) ON DELETE RESTRICT,
 waba_id TEXT NOT NULL CHECK (waba_id ~ '^[0-9]+$'),
 phone_number_id TEXT NOT NULL CHECK (phone_number_id ~ '^[0-9]+$'),
 sync_type TEXT NOT NULL CHECK (sync_type IN ('smb_app_state_sync','history')),
 onboarding_completed_at TIMESTAMPTZ NOT NULL,
 consent_granted BOOLEAN NOT NULL,
 consent_source TEXT NOT NULL CHECK (consent_source IN ('embedded_signup_owner','operator_verified')),
 consent_verified_by TEXT NOT NULL CHECK (length(consent_verified_by) BETWEEN 3 AND 128),
 approved_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL DEFAULT 'reserved'
   CHECK (state IN ('reserved','dispatching','accepted','rejected','unknown')),
 request_started_at TIMESTAMPTZ,
 resolved_at TIMESTAMPTZ,
 http_status INTEGER,
 provider_error_code TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 UNIQUE(waba_id,phone_number_id,sync_type),
 CHECK(sync_type <> 'history' OR consent_granted=TRUE)
);
CREATE INDEX IF NOT EXISTS idx_coex_sync_dispatch_review
 ON whatsapp_coexistence_sync_dispatch_requests(state,updated_at DESC);
COMMENT ON TABLE whatsapp_coexistence_sync_dispatch_requests IS
 'Once-only Meta POST ledger; dispatching/unknown NEVER automatically retry. Do not store token or Meta response body.';

CREATE TABLE IF NOT EXISTS whatsapp_pr395_legacy_lifecycle_alerts (
 fingerprint TEXT PRIMARY KEY REFERENCES whatsapp_legacy_lifecycle_relay_audit(fingerprint) ON DELETE RESTRICT,
 account_id TEXT NOT NULL CHECK(account_id ~ '^[0-9]+$'),
 event_type TEXT NOT NULL,
 severity TEXT NOT NULL CHECK(severity IN ('critical','review')),
 delivery_state TEXT NOT NULL DEFAULT 'pending'
   CHECK(delivery_state IN ('pending','processing','sent','unknown')),
 claim_started_at TIMESTAMPTZ,
 delivered_at TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pr395_legacy_lifecycle_alert_pending
 ON whatsapp_pr395_legacy_lifecycle_alerts(updated_at)
 WHERE delivery_state IN ('pending','unknown');
