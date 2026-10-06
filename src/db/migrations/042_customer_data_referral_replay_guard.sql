-- Preserve exact standalone Meta referral-event identity across a customer purge.
--
-- OPEN_THREAD referrals can arrive before the customer's first message. Store a
-- stable opaque event id with the short-lived pending attribution row so a
-- privacy purge can tombstone that exact old event without retaining the
-- customer's raw PSID/IGSID. A genuinely new referral event gets a new id and
-- remains eligible to create a fresh journey.
ALTER TABLE pending_lead_attributions
  ADD COLUMN IF NOT EXISTS event_id TEXT;

CREATE INDEX IF NOT EXISTS idx_pending_lead_attributions_event_id
  ON pending_lead_attributions (event_id)
  WHERE event_id IS NOT NULL;
