-- Admin-created promotional campaigns are immutable once created.
-- Always check live Meta approval, marketing consent and billing at send time.
CREATE TABLE IF NOT EXISTS whatsapp_promotional_blast_campaigns (
  campaign_key TEXT PRIMARY KEY CHECK (campaign_key ~ '^[a-z0-9_]{3,100}$'),
  template_name TEXT NOT NULL CHECK (template_name ~ '^[a-z0-9_]{3,100}$'),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
  promoted_treatment TEXT NOT NULL,
  target_treatments TEXT[] NOT NULL CHECK (cardinality(target_treatments) BETWEEN 1 AND 5),
  valid_until TIMESTAMPTZ NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO whatsapp_promotional_blast_campaigns
 (campaign_key,template_name,title,promoted_treatment,target_treatments,valid_until)
VALUES
 ('ns_3d_1111_rm388_2026','ns_3d_1111_rm388_2026',
  '11.11 3D 小颜术 · RM388','3D 小颜术',
  ARRAY['3D 小颜术','9D 逆龄抗衰','3D + 9D 组合']::text[],
  TIMESTAMPTZ '2026-11-30T15:59:59Z')
ON CONFLICT (campaign_key) DO NOTHING;

-- The token is per reservation and rotates only when an unused reservation
-- times out. A consumed reservation is irreversible even on a 4xx or timeout.
CREATE TABLE IF NOT EXISTS whatsapp_promotional_blast_claims (
  id BIGSERIAL PRIMARY KEY,
  campaign_key TEXT NOT NULL REFERENCES whatsapp_promotional_blast_campaigns(campaign_key),
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  recipient_key TEXT NOT NULL,
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id),
  language_code TEXT NOT NULL CHECK (language_code IN ('zh_CN','en_US','ms')),
  staff_username TEXT NOT NULL,
  reservation_token UUID NOT NULL,
  related_offer_reviewed BOOLEAN NOT NULL DEFAULT FALSE,
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','attempted')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempted_at TIMESTAMPTZ,
  UNIQUE(campaign_key,recipient_key),
  UNIQUE(campaign_key,contact_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_promo_blast_claims_contact
  ON whatsapp_promotional_blast_claims(contact_id,claimed_at DESC);
