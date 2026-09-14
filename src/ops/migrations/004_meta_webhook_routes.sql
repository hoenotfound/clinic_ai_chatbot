CREATE TABLE IF NOT EXISTS meta_webhook_routes (
  client_slug TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('facebook', 'instagram')),
  asset_id TEXT NOT NULL,
  target_base_url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (channel, asset_id),
  UNIQUE (client_slug, channel)
);

CREATE INDEX IF NOT EXISTS idx_meta_webhook_routes_lookup
ON meta_webhook_routes (channel, asset_id)
WHERE enabled = TRUE;

CREATE INDEX IF NOT EXISTS idx_meta_webhook_routes_client
ON meta_webhook_routes (client_slug, channel);
