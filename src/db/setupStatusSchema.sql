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
