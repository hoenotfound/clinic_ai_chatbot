CREATE TABLE IF NOT EXISTS config_import_snapshots (
  id BIGSERIAL PRIMARY KEY,
  editable_config JSONB NOT NULL,
  created_by TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('before_json_import', 'before_restore')),
  restored_from_snapshot_id BIGINT REFERENCES config_import_snapshots(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_config_import_snapshots_created_at
  ON config_import_snapshots(created_at DESC);
