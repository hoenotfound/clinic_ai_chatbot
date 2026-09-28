-- Upgrade the historical immediate-alert sent-marker table into a durable
-- delivery queue. Existing rows represent alerts that were already sent before
-- this migration, so they are backfilled as sent. Keep the database default as
-- sent for rolling-deploy/rollback compatibility with the old app, which inserts
-- a sent marker only after Telegram succeeds. The new queue writer explicitly
-- inserts status='pending' for new durable work.

ALTER TABLE telegram_immediate_alerts
  ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS message_text TEXT,
  ADD COLUMN IF NOT EXISTS status TEXT,
  ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stale_recoveries INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_token TEXT,
  ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS terminal_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS error_text TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();


DO $
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'telegram_immediate_alerts_lead_id_fkey'
      AND conrelid = 'telegram_immediate_alerts'::regclass
  ) THEN
    ALTER TABLE telegram_immediate_alerts
      ADD CONSTRAINT telegram_immediate_alerts_lead_id_fkey
      FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;
  END IF;
END
$;

UPDATE telegram_immediate_alerts
SET status = 'sent',
    sent_at = COALESCE(sent_at, created_at),
    updated_at = COALESCE(updated_at, created_at)
WHERE status IS NULL;

ALTER TABLE telegram_immediate_alerts
  ALTER COLUMN status SET DEFAULT 'sent',
  ALTER COLUMN status SET NOT NULL;

ALTER TABLE telegram_immediate_alerts
  DROP CONSTRAINT IF EXISTS telegram_immediate_alerts_status_check;

ALTER TABLE telegram_immediate_alerts
  ADD CONSTRAINT telegram_immediate_alerts_status_check
  CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'cancelled'));

ALTER TABLE telegram_immediate_alerts
  DROP CONSTRAINT IF EXISTS telegram_immediate_alerts_attempts_check;

ALTER TABLE telegram_immediate_alerts
  ADD CONSTRAINT telegram_immediate_alerts_attempts_check
  CHECK (attempts >= 0);

ALTER TABLE telegram_immediate_alerts
  DROP CONSTRAINT IF EXISTS telegram_immediate_alerts_stale_recoveries_check;

ALTER TABLE telegram_immediate_alerts
  ADD CONSTRAINT telegram_immediate_alerts_stale_recoveries_check
  CHECK (stale_recoveries >= 0);

CREATE INDEX IF NOT EXISTS idx_telegram_immediate_alerts_recovery
  ON telegram_immediate_alerts (status, next_attempt_at, claimed_at, created_at, id)
  WHERE terminal_at IS NULL AND status IN ('pending', 'sending');

CREATE INDEX IF NOT EXISTS idx_telegram_immediate_alerts_lead
  ON telegram_immediate_alerts (lead_id, alert_type, status, created_at DESC, id DESC)
  WHERE lead_id IS NOT NULL;
