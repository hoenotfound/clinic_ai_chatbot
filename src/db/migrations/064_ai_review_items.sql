-- Track each unresolved AI review independently of conversation ownership.
-- The visible Inbox mode remains AI; staff clears reviews through the existing
-- Needs Attention dismissal action.
CREATE TABLE IF NOT EXISTS ai_review_items (
  id BIGSERIAL PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  inbound_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('information', 'clinical')),
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (contact_id, inbound_message_id)
);

CREATE INDEX IF NOT EXISTS idx_ai_review_items_pending
  ON ai_review_items (contact_id, created_at, id)
  WHERE status = 'pending';
