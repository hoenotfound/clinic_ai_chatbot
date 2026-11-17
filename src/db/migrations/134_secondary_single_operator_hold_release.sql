-- Permit one identified operator instead of two independent reviewers.
-- Preserve historical two-reviewer audit records, receipt checks and no-retry protections.
-- This migration does not release holds or send messages.
SET LOCAL lock_timeout = '3s';
ALTER TABLE whatsapp_sender_unknown_hold_releases
  DROP CONSTRAINT IF EXISTS whatsapp_sender_unknown_distinct_reviewers;
ALTER TABLE whatsapp_sender_unknown_hold_releases
  ALTER COLUMN second_reviewer DROP NOT NULL;
ALTER TABLE whatsapp_sender_unknown_hold_releases
  ADD CONSTRAINT whatsapp_sender_unknown_optional_second_reviewer
  CHECK (second_reviewer IS NULL OR lower(first_reviewer) <> lower(second_reviewer));
COMMENT ON COLUMN whatsapp_sender_unknown_hold_releases.first_reviewer IS
  'Responsible operator for new single-operator releases; historical first reviewers remain unchanged.';
COMMENT ON COLUMN whatsapp_sender_unknown_hold_releases.second_reviewer IS
  'NULL for single-operator releases; preserved for historical independently reviewed releases.';
COMMENT ON TABLE whatsapp_sender_unknown_hold_releases IS
  'Externally attested, operator-reviewed release of one secondary billing gate. Original billing attempts remain UNKNOWN and cannot be replayed; release does not authorize customer messaging.';
