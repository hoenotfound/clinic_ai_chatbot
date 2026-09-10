ALTER TABLE ops_clients
  ADD COLUMN IF NOT EXISTS lifecycle_status TEXT;

-- Preserve the historical polling behavior for clients that were already
-- registered before lifecycle-aware monitoring existed.
UPDATE ops_clients
SET lifecycle_status = 'live'
WHERE lifecycle_status IS NULL;

-- Newly inserted clients start in setup so free/staging deployments are not
-- kept awake by the Registry's background polling loop.
ALTER TABLE ops_clients
  ALTER COLUMN lifecycle_status SET DEFAULT 'setup';

ALTER TABLE ops_clients
  ALTER COLUMN lifecycle_status SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'ops_clients_lifecycle_status_check'
      AND conrelid = 'ops_clients'::regclass
  ) THEN
    ALTER TABLE ops_clients
      ADD CONSTRAINT ops_clients_lifecycle_status_check
      CHECK (lifecycle_status IN ('setup', 'trial', 'live', 'paused'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ops_clients_lifecycle_status
  ON ops_clients (lifecycle_status);
