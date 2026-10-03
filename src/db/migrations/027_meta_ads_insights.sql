CREATE TABLE IF NOT EXISTS meta_ad_insights_daily (
  account_id TEXT NOT NULL,
  insight_date DATE NOT NULL,
  campaign_id TEXT,
  campaign_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  ad_id TEXT NOT NULL,
  ad_name TEXT,
  spend NUMERIC(16,4) NOT NULL DEFAULT 0,
  impressions BIGINT NOT NULL DEFAULT 0,
  reach BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  ctr NUMERIC(12,6),
  cpc NUMERIC(16,6),
  cpm NUMERIC(16,6),
  frequency NUMERIC(12,6),
  actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, insight_date, ad_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_ad_insights_daily_date
  ON meta_ad_insights_daily(insight_date DESC);

CREATE INDEX IF NOT EXISTS idx_meta_ad_insights_daily_campaign
  ON meta_ad_insights_daily(account_id, campaign_id, insight_date DESC)
  WHERE campaign_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_meta_ad_insights_daily_adset
  ON meta_ad_insights_daily(account_id, adset_id, insight_date DESC)
  WHERE adset_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_meta_ad_insights_daily_ad
  ON meta_ad_insights_daily(account_id, ad_id, insight_date DESC);

CREATE TABLE IF NOT EXISTS meta_ads_insights_sync_state (
  account_id TEXT PRIMARY KEY,
  last_attempt_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,
  last_error TEXT,
  last_backfill_completed_at TIMESTAMPTZ,
  last_range_start DATE,
  last_range_end DATE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
