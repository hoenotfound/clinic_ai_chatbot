-- Keep existing seven-day Click-to-WhatsApp blasts unchanged.
-- Past-lead outreach is a distinct opt-in-only audience.
ALTER TABLE whatsapp_promotional_blast_campaigns
  ADD COLUMN IF NOT EXISTS audience_mode TEXT NOT NULL DEFAULT 'recent_ad';
ALTER TABLE whatsapp_promotional_blast_campaigns
  ADD COLUMN IF NOT EXISTS package_name TEXT;
ALTER TABLE whatsapp_promotional_blast_campaigns
  ADD CONSTRAINT whatsapp_promo_blast_audience_mode_valid
  CHECK (audience_mode IN ('recent_ad','past_leads'));
ALTER TABLE whatsapp_promotional_blast_campaigns
  ADD CONSTRAINT whatsapp_promo_blast_past_package_required
  CHECK (audience_mode <> 'past_leads' OR NULLIF(BTRIM(package_name),'') IS NOT NULL);

-- Ready for manual preview and approval in the dashboard. The migration never sends.
INSERT INTO whatsapp_promotional_blast_campaigns
 (campaign_key,template_name,title,promoted_treatment,target_treatments,valid_until,created_by,audience_mode,package_name)
VALUES
 ('ns_pelvic_rm268_reengage_2026','ns_fu_pricing_graphic',
  '骨盆调理 Package B · RM268 (Past Leads)','骨盆调理',
  ARRAY['骨盆调理']::text[],TIMESTAMPTZ '2026-11-30T15:59:59Z',
  'system_migration','past_leads','Package B')
ON CONFLICT (campaign_key) DO NOTHING;
