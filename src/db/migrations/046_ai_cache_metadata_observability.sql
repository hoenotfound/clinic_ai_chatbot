-- Keep all historical ai_usage_events measurements intact.
-- NULL means cache-metadata availability was not recorded (or call failed).
-- TRUE means Gemini returned a cache count, including an explicit zero.
-- FALSE means Gemini omitted the cache-count field on a successful response.
ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS cache_metadata_present BOOLEAN;
ALTER TABLE ai_usage_events
  ADD COLUMN IF NOT EXISTS prompt_prefix_hash VARCHAR(16);
