-- ISOLATED QA DATABASE ONLY. Apply manually after schema inspection.
-- This is NOT a Neutro production migration or an automatic deployment.
-- Encrypted captures are retained until the receiving Inbox has durable jobs.
BEGIN;
SET LOCAL lock_timeout='3s';
ALTER TABLE whatsapp_secondary_qa_capture_events
  ADD COLUMN IF NOT EXISTS handoff_completed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_secondary_qa_handoff_pending
  ON whatsapp_secondary_qa_capture_events (received_at,fingerprint)
  WHERE handoff_completed_at IS NULL
    AND event_field IN ('history','smb_app_state_sync');
COMMENT ON COLUMN whatsapp_secondary_qa_capture_events.handoff_completed_at IS
 'Marks durable sender-scoped Inbox job staging, not completed history import. No automatic sending.';
COMMIT;
