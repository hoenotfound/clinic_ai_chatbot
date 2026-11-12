-- One audited, sender-bound exception for a verified Meta ad enquiry.
-- Not marketing consent. Only the existing 2h staff-question reminder is
-- eligible, and only inside the original customer's 24h WhatsApp window.
CREATE TABLE IF NOT EXISTS whatsapp_secondary_manual_service_followup_continuations (
 contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
 sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id),
 anchor_message_id INTEGER NOT NULL REFERENCES messages(id),
 staff_message_id INTEGER NOT NULL REFERENCES messages(id),
 approved_by TEXT NOT NULL CHECK (LENGTH(BTRIM(approved_by))>0),
 approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 expires_at TIMESTAMPTZ NOT NULL,
 CONSTRAINT service_continuation_expiry CHECK (expires_at>approved_at)
);
COMMENT ON TABLE whatsapp_secondary_manual_service_followup_continuations IS
 'Explicit operator-approved single service-window reminder after an authenticated staff question; not AI replay or MARKETING permission.';
