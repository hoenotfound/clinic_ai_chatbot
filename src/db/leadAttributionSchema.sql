-- First-touch acquisition attribution for each lead journey. Keep this separate
-- from contacts because the same person can return months later through a
-- different ad and create a new lead journey with a different source.
CREATE TABLE IF NOT EXISTS lead_attributions (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  first_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  source TEXT NOT NULL,
  platform TEXT,
  channel TEXT NOT NULL,
  meta_ad_id TEXT,
  meta_source_id TEXT,
  meta_source_type TEXT,
  referral_ref TEXT,
  referral_source TEXT,
  referral_type TEXT,
  ctwa_clid TEXT,
  source_url TEXT,
  headline TEXT,
  body TEXT,
  media_type TEXT,
  media_url TEXT,
  meta_account_id TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  adset_id TEXT,
  adset_name TEXT,
  ad_name TEXT,
  enrichment_status TEXT NOT NULL DEFAULT 'not_applicable',
  enrichment_attempts INTEGER NOT NULL DEFAULT 0,
  enrichment_last_attempt_at TIMESTAMPTZ,
  enrichment_next_attempt_at TIMESTAMPTZ,
  enrichment_last_error TEXT,
  enriched_at TIMESTAMPTZ,
  raw_referral JSONB,
  attributed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- PR #65 may already be deployed before this enrichment layer. Keep the
-- startup schema idempotent so existing lead_attributions rows gain the new
-- fields without a destructive migration.
ALTER TABLE lead_attributions
  ADD COLUMN IF NOT EXISTS meta_account_id TEXT,
  ADD COLUMN IF NOT EXISTS enrichment_status TEXT NOT NULL DEFAULT 'not_applicable',
  ADD COLUMN IF NOT EXISTS enrichment_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS enrichment_last_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enrichment_next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS enrichment_last_error TEXT,
  ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;

-- Any Meta ad rows captured by #65 before this migration should become
-- eligible for enrichment automatically. Only rows that already have all
-- three hierarchy names are treated as previously enriched; partial webhook
-- metadata stays pending so the Marketing API can complete it.
UPDATE lead_attributions
SET enrichment_status = CASE
      WHEN source = 'meta_ads' AND meta_ad_id IS NOT NULL THEN
        CASE
          WHEN ad_name IS NOT NULL AND adset_name IS NOT NULL AND campaign_name IS NOT NULL
            THEN 'enriched'
          ELSE 'pending'
        END
      ELSE 'not_applicable'
    END,
    enriched_at = CASE
      WHEN source = 'meta_ads'
       AND meta_ad_id IS NOT NULL
       AND enriched_at IS NULL
       AND ad_name IS NOT NULL
       AND adset_name IS NOT NULL
       AND campaign_name IS NOT NULL
        THEN updated_at
      ELSE enriched_at
    END
WHERE enrichment_status = 'not_applicable'
   OR (source = 'meta_ads' AND meta_ad_id IS NOT NULL AND enrichment_status <> 'enriched');

CREATE INDEX IF NOT EXISTS idx_lead_attributions_source
  ON lead_attributions(source, attributed_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_attributions_meta_ad
  ON lead_attributions(meta_ad_id)
  WHERE meta_ad_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_attributions_campaign
  ON lead_attributions(campaign_id)
  WHERE campaign_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lead_attributions_enrichment_pending
  ON lead_attributions(enrichment_next_attempt_at, attributed_at)
  WHERE enrichment_status = 'pending' AND meta_ad_id IS NOT NULL;

-- Facebook/Instagram can emit an OPEN_THREAD referral event separately from
-- the first actual message. Store it briefly so the next message from that
-- scoped user can inherit the referral without creating a fake chat message.
CREATE TABLE IF NOT EXISTS pending_lead_attributions (
  channel TEXT NOT NULL CHECK (channel IN ('facebook', 'instagram')),
  external_user_id TEXT NOT NULL,
  attribution JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
  PRIMARY KEY (channel, external_user_id)
);

CREATE INDEX IF NOT EXISTS idx_pending_lead_attributions_expiry
  ON pending_lead_attributions(expires_at);
