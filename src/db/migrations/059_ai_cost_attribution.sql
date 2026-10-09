-- Add optional per-customer cost attribution without changing any existing usage rows.
-- Unknown billing remains NULL, never a fabricated zero.
ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS lead_id INTEGER REFERENCES leads(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd NUMERIC(16,10),
  ADD COLUMN IF NOT EXISTS cache_write_tokens BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pricing_status TEXT;

CREATE INDEX IF NOT EXISTS idx_ai_usage_events_contact_day
  ON ai_usage_events (contact_id, created_at DESC)
  WHERE contact_id IS NOT NULL;

ALTER TABLE ai_usage_events
  ADD CONSTRAINT ai_usage_events_pricing_status_check
  CHECK (pricing_status IS NULL OR pricing_status IN
    ('estimated', 'unpriced_model', 'usage_unknown'));

-- Historical events have no contact/lead attribution, but provider-reported
-- Gemini tokens are sufficient for a transparent, model-based daily estimate.
-- Keep these rows unlinked to CRM leads. No attempt to infer billed usage when
-- usage metadata is unavailable, or unknown model/Claude cache breakdowns.
-- Rates match the supported 2026 Gemini rate table in aiCostEstimator.js.
WITH model_rates (model, input_usd, output_usd, cached_usd, promo_2026) AS (
  VALUES
    ('gemini-3.8-flash', 0.75::numeric, 3.75::numeric, 0.075::numeric, TRUE),
    ('gemini-3.7-flash', 0.75::numeric, 3.75::numeric, 0.075::numeric, TRUE),
    ('gemini-3.6-flash', 0.75::numeric, 3.75::numeric, 0.075::numeric, TRUE),
    ('gemini-3.5-flash', 1.50::numeric, 9.00::numeric, 0.15::numeric, FALSE),
    ('gemini-3.5-flash-lite', 0.30::numeric, 2.50::numeric, 0.03::numeric, FALSE),
    ('gemini-3.5-transcribe', 2.00::numeric, 12.00::numeric, 2.00::numeric, FALSE)
),
evaluated AS (
  SELECT a.id,
    (COALESCE(a.prompt_tokens, 0) + COALESCE(a.output_tokens, 0)
      + COALESCE(a.thinking_tokens, 0)) > 0 AS has_usage,
    CASE WHEN a.provider = 'gemini' AND r.model IS NOT NULL THEN
      ROUND((
        GREATEST(COALESCE(a.prompt_tokens, 0) - COALESCE(a.cached_tokens, 0), 0)
          * (CASE WHEN r.promo_2026 AND a.created_at >= TIMESTAMPTZ '2027-01-01'
              THEN 2 ELSE 1 END) * r.input_usd
        + LEAST(COALESCE(a.prompt_tokens, 0), COALESCE(a.cached_tokens, 0))
          * (CASE WHEN r.promo_2026 AND a.created_at >= TIMESTAMPTZ '2027-01-01'
              THEN 2 ELSE 1 END) * r.cached_usd
        + (COALESCE(a.output_tokens, 0) + COALESCE(a.thinking_tokens, 0))
          * (CASE WHEN r.promo_2026 AND a.created_at >= TIMESTAMPTZ '2027-01-01'
              THEN 2 ELSE 1 END) * r.output_usd
      ) / 1000000, 10)
    ELSE NULL END AS estimated_usd
  FROM ai_usage_events a
  LEFT JOIN model_rates r ON a.model = r.model
  WHERE a.pricing_status IS NULL
)
UPDATE ai_usage_events e
SET estimated_cost_usd = CASE WHEN evaluated.has_usage
    THEN evaluated.estimated_usd ELSE NULL END,
  pricing_status = CASE
    WHEN NOT evaluated.has_usage THEN 'usage_unknown'
    WHEN evaluated.estimated_usd IS NULL THEN 'unpriced_model'
    ELSE 'estimated'
  END
FROM evaluated
WHERE e.id = evaluated.id;
