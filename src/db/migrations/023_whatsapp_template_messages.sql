ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS whatsapp_template JSONB;

COMMENT ON COLUMN messages.whatsapp_template IS
  'Metadata for an outbound WhatsApp template send: template name, language, category and exact send components. NULL for ordinary messages.';
