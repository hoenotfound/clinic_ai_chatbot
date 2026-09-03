-- WhatsApp messaging-policy state.
--
-- A phone number by itself is never treated as permission to initiate messages.
-- `whatsapp_opt_in_at` is only for explicit consent captured by the clinic from
-- a real source (web form, signed form, customer request, etc.).
-- `whatsapp_opt_out_at` is a hard suppression flag. Once set, normal outbound
-- WhatsApp sends are blocked until staff records a later explicit opt-in.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in_at TIMESTAMPTZ;
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_opt_in_source TEXT;
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_opt_out_at TIMESTAMPTZ;
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_opt_out_source TEXT;

CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_opt_out
  ON contacts(whatsapp_opt_out_at)
  WHERE channel = 'whatsapp' AND whatsapp_opt_out_at IS NOT NULL;
