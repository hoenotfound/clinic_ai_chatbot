CREATE TABLE IF NOT EXISTS customer_data_exports (
  id BIGSERIAL PRIMARY KEY,
  username TEXT NOT NULL,
  preset TEXT NOT NULL CHECK (preset IN ('customer', 'full')),
  scope TEXT NOT NULL CHECK (scope IN ('current', 'all')),
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  filters JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_data_exports_created_at
  ON customer_data_exports(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_customer_data_exports_username_created_at
  ON customer_data_exports(username, created_at DESC);
