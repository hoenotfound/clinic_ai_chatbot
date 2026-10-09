-- Add optional per-customer cost attribution without changing any existing usage rows.
-- Unknown billing remains NULL, never a fabricated zero.
ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(16,10),
  ADD COLUMN IF NOT EXISTS pricing_status TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_contact_day
  ON ai_usage_events (contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

ALTER TABLE ai_usage_events
  ADD CONSTRAINT ai_usage_events_pricing_status_check
  CHECK (pricing_status IS NULL OR pricing_status IN
    ('estimated', 'unpriced_model', 'usage_unknown'));
