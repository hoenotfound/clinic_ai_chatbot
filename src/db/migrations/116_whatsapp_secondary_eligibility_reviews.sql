-- A contact-only coexistence sync is not proof of a prior conversation.
-- The six-month Meta history window is also not proof that no older chat exists.
-- Remain manual unless a named operator checked the full secondary Business
-- App chat history and the primary number's authoritative chat history.
-- This table grants no outbound permission on its own.
CREATE TABLE IF NOT EXISTS whatsapp_secondary_ad_eligibility_reviews (
  contact_id INTEGER PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  origin_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN (
    'no_prior_conversation_verified', 'historical_or_unknown'
  )),
  reviewed_by TEXT NOT NULL CHECK (LENGTH(BTRIM(reviewed_by)) >= 3),
  secondary_app_history_checked BOOLEAN NOT NULL DEFAULT FALSE,
  primary_history_checked BOOLEAN NOT NULL DEFAULT FALSE,
  review_note TEXT NOT NULL DEFAULT '',
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT secondary_review_requires_both_history_checks CHECK (
    decision <> 'no_prior_conversation_verified'
    OR (
      secondary_app_history_checked = TRUE
      AND primary_history_checked = TRUE
      AND LENGTH(BTRIM(review_note)) >= 10
    )
  )
);
COMMENT ON TABLE whatsapp_secondary_ad_eligibility_reviews IS
  'Manual, audited, sender-specific review of an otherwise excluded first CTWA lead. Both numbers' full history sources (including the secondary Business App outside its imported history window), must be checked. A verified decision does not replay or send the original message.';
CREATE INDEX IF NOT EXISTS idx_secondary_ad_eligibility_review_origin
  ON whatsapp_secondary_ad_eligibility_reviews(origin_message_id);
