CREATE TABLE IF NOT EXISTS whatsapp_coexistence_onboarding_attempts (
  id BIGSERIAL PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('validated', 'failed')),
  waba_id TEXT,
  phone_number_id TEXT,
  display_phone_number TEXT,
  verified_name TEXT,
  coexistence_ready BOOLEAN,
  event_version INTEGER,
  token_expires_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  started_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS whatsapp_coexistence_onboarding_attempts_created_idx
  ON whatsapp_coexistence_onboarding_attempts (created_at DESC, id DESC);

COMMENT ON TABLE whatsapp_coexistence_onboarding_attempts IS
  'Non-secret audit metadata for WhatsApp Business App Embedded Signup attempts. Access tokens and authorization codes are never stored.';
