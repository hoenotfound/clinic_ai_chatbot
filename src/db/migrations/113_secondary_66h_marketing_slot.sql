-- Allow the approved 66h Neutro WhatsApp template to be configured.
-- Retain legacy 72h rule rows without silently migrating/activating them.
-- The 48h/66h worker uses only explicitly approved, consented rules.
ALTER TABLE whatsapp_sender_marketing_followup_rules
  DROP CONSTRAINT IF EXISTS whatsapp_sender_marketing_followup_rules_slot_hours_check;
ALTER TABLE whatsapp_sender_marketing_followup_rules
  ADD CONSTRAINT whatsapp_sender_marketing_followup_rules_slot_hours_check
  CHECK (slot_hours IN (48, 66, 72));
