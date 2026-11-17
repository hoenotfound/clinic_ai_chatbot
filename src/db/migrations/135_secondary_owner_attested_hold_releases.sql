-- Audit exact-contact UNKNOWN billing holds released after the account owner's
-- direct confirmation of no Meta charge and no Business App delivery.
-- This is USER-REPORTED external evidence, not a signed Meta billing receipt.
-- This table alone never authorizes sends, replays or promotions.
SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS whatsapp_sender_owner_attested_unknown_hold_releases (
  reservation_id UUID PRIMARY KEY
    REFERENCES whatsapp_sender_billing_attempts(reservation_id) ON DELETE RESTRICT,
  sender_id BIGINT NOT NULL
    REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  contact_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL
    REFERENCES messages(id) ON DELETE RESTRICT,
  release_basis TEXT NOT NULL
    CHECK (release_basis IN ('signed_failed', 'unconfirmed_no_wamid')),
  no_charge_owner_reported BOOLEAN NOT NULL
    CHECK (no_charge_owner_reported=TRUE),
  business_app_no_delivery_owner_reported BOOLEAN NOT NULL
    CHECK (business_app_no_delivery_owner_reported=TRUE),
  original_message_retry_prohibited BOOLEAN NOT NULL DEFAULT TRUE
    CHECK (original_message_retry_prohibited=TRUE),
  attestation_source TEXT NOT NULL
    CHECK (attestation_source IN ('chat_owner_confirmation_2026_11_18')),
  released_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (contact_id,sender_id)
    REFERENCES contacts(id,whatsapp_sender_id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_whatsapp_owner_attested_releases_contact
 ON whatsapp_sender_owner_attested_unknown_hold_releases
  (sender_id,contact_id,released_at DESC);

COMMENT ON TABLE whatsapp_sender_owner_attested_unknown_hold_releases IS
  'Owner-reported no-charge/no-delivery attestation for a specific historical UNKNOWN sender reservation. It is not independent Meta billing evidence; original send and billing attempt stay unchanged and never replay.';
COMMENT ON COLUMN whatsapp_sender_owner_attested_unknown_hold_releases.no_charge_owner_reported IS
  'The user says Meta did not charge for this attempt; independently unverified.';
COMMENT ON COLUMN whatsapp_sender_owner_attested_unknown_hold_releases.business_app_no_delivery_owner_reported IS
  'The user says the original media did not arrive in their secondary WhatsApp Business App; independently unverified.';
