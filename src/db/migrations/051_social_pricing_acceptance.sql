-- Conservative receipt time after Meta's successful Messenger / Instagram Send API response.
-- Old social messages are intentionally not backfilled: creation time is not acceptance.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS social_accepted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pricing_social_receipt
  ON messages (contact_id, social_accepted_at)
  WHERE is_automated_follow_up = true
    AND automated_follow_up_step = 3
    AND social_accepted_at IS NOT NULL;
