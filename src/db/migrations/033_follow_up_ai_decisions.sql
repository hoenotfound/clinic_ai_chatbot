CREATE TABLE IF NOT EXISTS follow_up_ai_decisions (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  trigger_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  follow_up_step INTEGER NOT NULL,
  action TEXT NOT NULL,
  reason TEXT,
  topic TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT follow_up_ai_decisions_step_check
    CHECK (follow_up_step BETWEEN 1 AND 3),
  CONSTRAINT follow_up_ai_decisions_action_check
    CHECK (action IN ('skip', 'human_review')),
  CONSTRAINT follow_up_ai_decisions_anchor_step_unique
    UNIQUE (trigger_message_id, follow_up_step)
);

CREATE INDEX IF NOT EXISTS idx_follow_up_ai_decisions_contact_anchor
  ON follow_up_ai_decisions(contact_id, trigger_message_id, created_at DESC);

COMMENT ON TABLE follow_up_ai_decisions IS
  'Durable terminal AI follow-up decisions that stop a silent-conversation sequence without creating a customer-visible message.';
