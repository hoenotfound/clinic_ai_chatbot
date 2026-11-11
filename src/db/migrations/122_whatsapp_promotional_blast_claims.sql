-- One contact/customer address can be targeted only once per promotion, across
-- primary and secondary WhatsApp numbers. Ambiguous sends are never retried.
CREATE TABLE IF NOT EXISTS whatsapp_promotional_blast_claims (
  id BIGSERIAL PRIMARY KEY,
  campaign_key TEXT NOT NULL CHECK (campaign_key ~ '^[a-z0-9_]{3,100}$'),
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  recipient_key TEXT NOT NULL,
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id),
  language_code TEXT NOT NULL CHECK (language_code IN ('zh_CN','en_US','ms')),
  staff_username TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'reserved'
    CHECK (state IN ('reserved','attempted')),
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempted_at TIMESTAMPTZ,
  UNIQUE(campaign_key,recipient_key),
  UNIQUE(campaign_key,contact_id)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_promo_blast_claims_contact
  ON whatsapp_promotional_blast_claims(contact_id,claimed_at DESC);
