-- Support the read paths introduced by Meta Ads → CRM analytics.
--
-- Pipeline fallback looks up the latest hierarchy by ad_id without knowing the
-- ad account first, so the existing (account_id, ad_id, insight_date) index
-- cannot efficiently serve that query.
CREATE INDEX IF NOT EXISTS idx_meta_ad_insights_daily_ad_latest
  ON meta_ad_insights_daily(ad_id, insight_date DESC, updated_at DESC);

-- Analytics sync/status cards fetch only the latest row for each configured
-- account. Keep that lookup index-backed instead of aggregating the full
-- historical Insights table on every dashboard request.
CREATE INDEX IF NOT EXISTS idx_meta_ad_insights_daily_account_latest
  ON meta_ad_insights_daily(account_id, insight_date DESC, updated_at DESC);
