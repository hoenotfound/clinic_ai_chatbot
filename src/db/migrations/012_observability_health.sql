-- Operational health telemetry for Setup Status.
-- Keep this focused on low-volume diagnostic state. Retention/cleanup belongs
-- in the separate retention PR.

-- Failure history is kept separately from the durable job row so a job that
-- later recovers/completes still contributes to the last-24-hour diagnostic.
-- No customer content or contact identifiers are stored here.
CREATE TABLE IF NOT EXISTS inbound_failure_events (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('message', 'meta_resolution')),
  job_id BIGINT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'facebook', 'instagram')),
  failed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbound_failure_events_failed_at
  ON inbound_failure_events (failed_at DESC);

-- A restart/stale-worker recovery is a processing lease that is reclaimed by
-- a different process owner. Ordinary pending jobs and same-process retries do
-- not count as restart recoveries.
CREATE TABLE IF NOT EXISTS inbound_recovery_events (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('message', 'meta_resolution')),
  job_id BIGINT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'facebook', 'instagram')),
  recovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbound_recovery_events_recovered_at
  ON inbound_recovery_events (recovered_at DESC);

CREATE OR REPLACE FUNCTION record_inbound_job_health_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_job_type TEXT;
BEGIN
  resolved_job_type := CASE
    WHEN TG_TABLE_NAME = 'inbound_meta_resolution_jobs' THEN 'meta_resolution'
    ELSE 'message'
  END;

  IF NEW.status = 'failed' AND OLD.status IS DISTINCT FROM 'failed' THEN
    INSERT INTO inbound_failure_events (job_type, job_id, channel, failed_at)
    VALUES (resolved_job_type, NEW.id, NEW.channel, NOW());
  END IF;

  IF OLD.status = 'processing'
     AND NEW.status = 'processing'
     AND NEW.attempts > OLD.attempts
     AND OLD.lease_owner IS DISTINCT FROM NEW.lease_owner
     AND OLD.lease_owner IS NOT NULL
     AND NEW.lease_owner IS NOT NULL THEN
    INSERT INTO inbound_recovery_events (job_type, job_id, channel, recovered_at)
    VALUES (resolved_job_type, NEW.id, NEW.channel, NOW());
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_inbound_processing_health_event
  ON inbound_processing_jobs;
CREATE TRIGGER trg_inbound_processing_health_event
AFTER UPDATE ON inbound_processing_jobs
FOR EACH ROW
EXECUTE FUNCTION record_inbound_job_health_event();

DROP TRIGGER IF EXISTS trg_inbound_meta_resolution_health_event
  ON inbound_meta_resolution_jobs;
CREATE TRIGGER trg_inbound_meta_resolution_health_event
AFTER UPDATE ON inbound_meta_resolution_jobs
FOR EACH ROW
EXECUTE FUNCTION record_inbound_job_health_event();

-- High-level AI routing outcomes only. No prompts, responses, API keys,
-- fingerprints, contact ids, or other customer data are stored here.
CREATE TABLE IF NOT EXISTS ai_routing_events (
  id BIGSERIAL PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (
    event_type IN ('gemini_model_fallback', 'claude_fallback', 'ai_failure')
  ),
  provider TEXT CHECK (provider IN ('gemini', 'claude')),
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_routing_events_created_at
  ON ai_routing_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_routing_events_type_created_at
  ON ai_routing_events (event_type, created_at DESC);
