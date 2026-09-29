ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_marketing_opt_out_at TIMESTAMPTZ;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS whatsapp_marketing_opt_out_source TEXT;

UPDATE contacts
SET whatsapp_marketing_opt_out_at = whatsapp_opt_out_at,
    whatsapp_marketing_opt_out_source = COALESCE(
      whatsapp_opt_out_source,
      'legacy_global_opt_out'
    )
WHERE whatsapp_opt_out_at IS NOT NULL
  AND whatsapp_marketing_opt_out_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_whatsapp_marketing_opt_out
  ON contacts(whatsapp_marketing_opt_out_at)
  WHERE whatsapp_marketing_opt_out_at IS NOT NULL;

COMMENT ON COLUMN contacts.whatsapp_marketing_opt_out_at IS
  'When the customer opted out of WhatsApp marketing/promotional messages only. Does not block service or utility messaging by itself.';

COMMENT ON COLUMN contacts.whatsapp_marketing_opt_out_source IS
  'Source of the marketing-only WhatsApp opt-out, such as customer_message or customer_quick_reply.';
