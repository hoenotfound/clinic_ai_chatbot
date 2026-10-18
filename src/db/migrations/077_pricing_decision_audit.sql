-- Staff-only pricing pipeline decision stages for support and regressions.
-- No customer message text, phone number or Meta creative is stored here.
-- One row per inbound price enquiry; optional audit never gates replies.
CREATE TABLE IF NOT EXISTS pricing_decision_audit (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  inbound_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('off', 'shadow', 'enabled')),
  observed BOOLEAN NOT NULL DEFAULT FALSE,
  approved BOOLEAN NOT NULL DEFAULT FALSE,
  approval_reason TEXT NOT NULL,
  treatment TEXT,
  decision_source TEXT,
  reply_status TEXT NOT NULL,
  media_status TEXT NOT NULL CHECK (media_status IN ('selected','skipped')),
  media_reason TEXT,
  media_packages_selected INTEGER NOT NULL DEFAULT 0 CHECK (media_packages_selected BETWEEN 0 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pricing_decision_audit_contact_created
  ON pricing_decision_audit (contact_id, created_at DESC);
