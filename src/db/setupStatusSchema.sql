CREATE TABLE IF NOT EXISTS setup_connection_health (
  check_key TEXT PRIMARY KEY,
  last_check_status TEXT CHECK (
    last_check_status IS NULL OR
    last_check_status IN ('ready', 'warning', 'error', 'not_configured')
  ),
  last_check_summary TEXT,
  last_checked_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_webhook_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS setup_ai_candidate_health (
  candidate_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'claude')),
  last_status TEXT NOT NULL CHECK (
    last_status IN ('ready', 'rate_limited', 'unavailable', 'invalid', 'failed')
  ),
  last_failure_kind TEXT,
  last_attempt_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_rate_limited_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Setup Status metadata checks are kept separate from real runtime candidate
-- health so pressing "Run all checks" can never change customer-reply routing,
-- active-key preference, or cooldown state.
CREATE TABLE IF NOT EXISTS setup_ai_candidate_checks (
  candidate_key TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('gemini', 'claude')),
  last_status TEXT NOT NULL CHECK (
    last_status IN ('ready', 'rate_limited', 'unavailable', 'invalid', 'failed')
  ),
  last_failure_kind TEXT,
  last_checked_at TIMESTAMPTZ NOT NULL,
  last_success_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_usage_events (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed')),
  failure_kind TEXT,
  prompt_tokens BIGINT NOT NULL DEFAULT 0 CHECK (prompt_tokens >= 0),
  output_tokens BIGINT NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  thinking_tokens BIGINT NOT NULL DEFAULT 0 CHECK (thinking_tokens >= 0),
  cached_tokens BIGINT NOT NULL DEFAULT 0 CHECK (cached_tokens >= 0),
  total_tokens BIGINT NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_created_at
  ON ai_usage_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_model_created_at
  ON ai_usage_events (provider, model, created_at DESC);
