-- PR395 secure, account-scoped Embedded Signup credential handoff.
-- One authenticated authorization attempt owns one separately encrypted token.
-- NO tokens are stored in plaintext or exposed through the staff portal.
SET LOCAL lock_timeout='3s';
CREATE TABLE IF NOT EXISTS whatsapp_coexistence_onboarding_credentials (
  attempt_id BIGINT PRIMARY KEY REFERENCES whatsapp_coexistence_onboarding_attempts(id) ON DELETE CASCADE,
  waba_id TEXT NOT NULL CHECK(waba_id ~ '^[0-9]+$'),
  phone_number_id TEXT NOT NULL CHECK(phone_number_id ~ '^[0-9]+$'),
  key_version TEXT NOT NULL DEFAULT 'v1' CHECK(key_version='v1'),
  nonce BYTEA NOT NULL CHECK(octet_length(nonce)=12),
  ciphertext BYTEA NOT NULL CHECK(octet_length(ciphertext)>0),
  auth_tag BYTEA NOT NULL CHECK(octet_length(auth_tag)=16),
  token_expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_coexistence_credentials_scope
  ON whatsapp_coexistence_onboarding_credentials(waba_id,phone_number_id,created_at DESC);
