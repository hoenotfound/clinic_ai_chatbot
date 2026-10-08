-- Keep Meta social-channel opt-outs separate from WhatsApp opt-in/opt-out semantics.
-- Each contact belongs to a single channel; no existing WhatsApp consent is modified.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS social_opt_out_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS social_opt_out_source TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS social_marketing_opt_out_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS social_marketing_opt_out_source TEXT;
