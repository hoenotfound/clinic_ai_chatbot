-- Track each real inbound Click-to-WhatsApp ad entry independently of
-- immutable CRM first-touch attribution. No historical backfill: only inbound
-- messages with actual referral evidence may create a session.
CREATE TABLE IF NOT EXISTS whatsapp_free_entry_referrals (
  origin_message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  ctwa_clid TEXT,
  meta_ad_id TEXT,
  ad_name TEXT,
  treatment_interest TEXT,
  source_type TEXT NOT NULL CHECK (source_type = 'ad'),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ctwa_clid IS NOT NULL OR meta_ad_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_fep_referrals_contact
 ON whatsapp_free_entry_referrals(contact_id, recorded_at DESC, origin_message_id DESC);
