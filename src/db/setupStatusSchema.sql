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

