ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS automated_follow_up_message_mode TEXT;

CREATE TABLE IF NOT EXISTS follow_up_ai_generation_claims (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  trigger_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  follow_up_step INTEGER NOT NULL,
  lease_token TEXT NOT NULL,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT follow_up_ai_generation_claims_step_check
    CHECK (follow_up_step BETWEEN 1 AND 3),
  CONSTRAINT follow_up_ai_generation_claims_anchor_step_unique
    UNIQUE (trigger_message_id, follow_up_step)
);

CREATE INDEX IF NOT EXISTS idx_follow_up_ai_generation_claims_stale
  ON follow_up_ai_generation_claims(claimed_at, id);

CREATE INDEX IF NOT EXISTS idx_follow_up_ai_generation_claims_contact
  ON follow_up_ai_generation_claims(contact_id, trigger_message_id, follow_up_step);

COMMENT ON COLUMN messages.automated_follow_up_message_mode IS
  'How an automated follow-up message was produced: fixed, ai_personalized, or ai_fallback.';

COMMENT ON TABLE follow_up_ai_generation_claims IS
  'Short-lived leases preventing duplicate AI generation for the same follow-up step across app instances.';
