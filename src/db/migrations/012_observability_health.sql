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

-- Restart recovery events are recorded only for jobs reclaimed by the first
-- recovery sweep after this process starts. This avoids presenting ordinary
-- periodic retries as Render restart recoveries.
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
