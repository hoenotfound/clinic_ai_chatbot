-- Combined Phase 2: one provider attempt for each saved secondary message.
-- A retry must be a new, explicitly reviewed operation and cannot silently
-- resend an ambiguous customer message after a worker restart.
SET LOCAL lock_timeout = '3s';

CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_sender_billing_attempt_message_once
  ON whatsapp_sender_billing_attempts(sender_id, message_id)
  WHERE message_id IS NOT NULL;

COMMENT ON INDEX idx_whatsapp_sender_billing_attempt_message_once IS
 'Secondary messages may not be resent via a second billing reservation; unknown Meta acceptance must be reconciled.';
