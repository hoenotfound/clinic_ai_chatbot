-- Extend independently consented secondary marketing template schedule.
-- This changes database acceptance only. Day 4/6 sends are separately gated by
-- Meta-approved secondary templates, scoped billing/consent and an OFF-by-default
-- extended-schedule switch. Retain legacy 72-hour records for audit/history.
ALTER TABLE whatsapp_sender_marketing_followup_rules
  DROP CONSTRAINT IF EXISTS whatsapp_sender_marketing_followup_rules_slot_hours_check;
ALTER TABLE whatsapp_sender_marketing_followup_rules
  ADD CONSTRAINT whatsapp_sender_marketing_followup_rules_slot_hours_check
  CHECK (slot_hours IN (48, 66, 72, 96, 144));

-- 113 originally updated rule constraints but not attempts. Include 66 in
-- send-attempts as well; otherwise consented 66h sends fail at claim time.
ALTER TABLE whatsapp_sender_marketing_followup_attempts
  DROP CONSTRAINT IF EXISTS whatsapp_sender_marketing_followup_attempts_slot_hours_check;
ALTER TABLE whatsapp_sender_marketing_followup_attempts
  ADD CONSTRAINT whatsapp_sender_marketing_followup_attempts_slot_hours_check
  CHECK (slot_hours IN (48, 66, 72, 96, 144));
