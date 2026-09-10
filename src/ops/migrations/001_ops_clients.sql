CREATE TABLE IF NOT EXISTS ops_clients (
  client_slug TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  industry TEXT,
  purchased_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  token_env_key TEXT NOT NULL,
  render_service_id TEXT,
  render_service_name TEXT,
  neon_project_id TEXT,
  neon_project_name TEXT,
  provisioned_commit_sha TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_poll_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_http_status INTEGER,
  last_status TEXT,
  last_schema_version INTEGER,
  last_snapshot JSONB,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_ops_clients_last_status
  ON ops_clients (last_status);

CREATE INDEX IF NOT EXISTS idx_ops_clients_last_success_at
  ON ops_clients (last_success_at DESC);
