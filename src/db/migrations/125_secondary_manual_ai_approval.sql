-- Seven-day staff-approved AI access for legacy secondary contacts.
-- Approval is not marketing consent and cannot restart historical follow-ups.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_secondary_manual_ai_approved_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_secondary_manual_ai_approved_until TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS whatsapp_secondary_manual_ai_approved_by TEXT;
