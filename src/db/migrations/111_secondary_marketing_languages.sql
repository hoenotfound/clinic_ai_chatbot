-- Multiple independently approved language variants per secondary 48/72h slot.
-- Preserve every existing rule and the single one-shot attempt per slot/contact.
-- No worker, outbound or billing flag is enabled by this migration.
SET LOCAL lock_timeout = '3s';
ALTER TABLE whatsapp_sender_marketing_followup_rules
  DROP CONSTRAINT whatsapp_sender_marketing_followup_rules_pkey;
ALTER TABLE whatsapp_sender_marketing_followup_rules
  ADD CONSTRAINT whatsapp_sender_marketing_followup_rules_pkey
    PRIMARY KEY (sender_id,slot_hours,language_code);
