-- Manual resolution of an individual secondary sender UNKNOWN hold.
-- A release does not prove delivery or billing, nor authorize replay of the old send.
-- No worker, webhook, or startup action writes this table.
SET LOCAL lock_timeout = '3s';
CREATE TABLE IF NOT EXISTS whatsapp_sender_unknown_hold_releases (
  reservation_id UUID PRIMARY KEY
    REFERENCES whatsapp_sender_billing_attempts(reservation_id) ON DELETE CASCADE,
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE RESTRICT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  release_basis TEXT NOT NULL CHECK (release_basis IN ('signed_failed','unconfirmed_no_wamid')),
  billing_hub_no_charge_checked BOOLEAN NOT NULL CHECK (billing_hub_no_charge_checked=TRUE),
  business_app_reviewed BOOLEAN NOT NULL CHECK (business_app_reviewed=TRUE),
  old_message_retry_prohibited BOOLEAN NOT NULL CHECK (old_message_retry_prohibited=TRUE),
  first_reviewer TEXT NOT NULL CHECK (length(first_reviewer) BETWEEN 3 AND 80),
  second_reviewer TEXT NOT NULL CHECK (length(second_reviewer) BETWEEN 3 AND 80),
  evidence_ticket TEXT NOT NULL CHECK (evidence_ticket ~ '^[A-Z0-9_-]{8,80}$'),
  released_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT whatsapp_sender_unknown_distinct_reviewers
    CHECK (lower(first_reviewer) <> lower(second_reviewer))
);
COMMENT ON TABLE whatsapp_sender_unknown_hold_releases IS
  'Owner-authorized, independently reviewed release of a secondary contact billing gate. Historical delivery outcome stays UNKNOWN, and old sends are never retried. Billing Hub and Business App checks are human attestations, not verified API evidence.';
CREATE INDEX IF NOT EXISTS idx_whatsapp_sender_unknown_hold_release_contact
  ON whatsapp_sender_unknown_hold_releases(sender_id,contact_id,released_at DESC);
