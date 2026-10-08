-- Keep the reminder opt-in and record when a customer never asked for prices.
-- Existing durable decisions remain unchanged.
ALTER TABLE pricing_reminder_decisions
  DROP CONSTRAINT IF EXISTS pricing_reminder_decisions_reason_check;
ALTER TABLE pricing_reminder_decisions
  ADD CONSTRAINT pricing_reminder_decisions_reason_check
  CHECK (reason IN (
    'already_sent', 'delivery_review', 'ambiguous_service',
    'ambiguous_package', 'missing_promotion', 'insufficient_window',
    'no_pricing_interest'
  ));
