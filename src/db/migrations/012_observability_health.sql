-- Operational health telemetry for Setup Status.
-- Keep this focused on low-volume diagnostic state. Retention/cleanup belongs
-- in the separate retention PR.

ALTER TABLE inbound_processing_jobs
  ADD COLUMN IF NOT EXISTS last_failed_at TIMESTAMPTZ;

ALTER TABLE inbound_meta_resolution_jobs
  ADD COLUMN IF NOT EXISTS last_failed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_inbound_processing_jobs_last_failed
  ON inbound_processing_jobs (last_failed_at)
  WHERE last_failed_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_inbound_meta_resolution_last_failed
  ON inbound_meta_resolution_jobs (last_failed_at)
  WHERE last_failed_at IS NOT NULL;

-- Records only stale processing leases that were reclaimed by the recovery
-- sweep. It contains no customer content or identifiers and lets Setup Status
-- distinguish a real restart/crash recovery from an ordinary retry.
CREATE TABLE IF NOT EXISTS inbound_recovery_events (
  id BIGSERIAL PRIMARY KEY,
  job_type TEXT NOT NULL CHECK (job_type IN ('message', 'meta_resolution')),
  job_id BIGINT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'facebook', 'instagram')),
  recovered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inbound_recovery_events_recovered_at
  ON inbound_recovery_events (recovered_at DESC);

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
