ALTER TABLE meta_ads_insights_sync_state
  ADD COLUMN IF NOT EXISTS coverage_start_date DATE,
  ADD COLUMN IF NOT EXISTS coverage_end_date DATE;

COMMENT ON COLUMN meta_ads_insights_sync_state.coverage_start_date IS
  'Earliest date in the current contiguous Meta Insights coverage window verified by successful syncs.';
COMMENT ON COLUMN meta_ads_insights_sync_state.coverage_end_date IS
  'Latest date in the current contiguous Meta Insights coverage window verified by successful syncs.';
