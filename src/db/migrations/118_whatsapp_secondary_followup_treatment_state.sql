-- Sender-specific durable customer treatment evidence, NOT CRM/marketing consent.
-- Never copy history, ad names, AI summaries or staff replies into this table.
CREATE TABLE IF NOT EXISTS whatsapp_sender_followup_treatment_state (
  sender_id BIGINT NOT NULL REFERENCES whatsapp_sender_accounts(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  source_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('selected','ambiguous','declined','deferred')),
  treatment_name TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sender_id, contact_id),
  CHECK ((status='selected' AND NULLIF(BTRIM(treatment_name),'') IS NOT NULL)
    OR (status<>'selected' AND treatment_name IS NULL))
);
-- Existing provider-verified messages are intentionally NOT backfilled:
-- replaying old refusals or guessed ad treatments would modify eligibility.
