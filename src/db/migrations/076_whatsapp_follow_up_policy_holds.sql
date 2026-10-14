-- Durable, reversible postponement of strict billing/policy-blocked follow-ups.
-- A hold never counts as a sent message or consumes a follow-up sequence step.
CREATE TABLE IF NOT EXISTS whatsapp_follow_up_policy_holds (
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  trigger_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  follow_up_step INTEGER NOT NULL CHECK (follow_up_step BETWEEN 1 AND 3),
  reason TEXT NOT NULL,
  retry_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, trigger_message_id, follow_up_step)
);
CREATE INDEX IF NOT EXISTS idx_whatsapp_follow_up_policy_holds_retry
  ON whatsapp_follow_up_policy_holds(retry_at);
