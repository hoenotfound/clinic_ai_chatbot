CREATE TABLE IF NOT EXISTS meta_comment_automation_jobs (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('facebook', 'instagram')),
  comment_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT,
  comment_text TEXT NOT NULL,
  post_id TEXT,
  media_id TEXT,
  parent_comment_id TEXT,
  source_created_at TIMESTAMPTZ,
  raw_event JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'completed', 'skipped', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  public_reply_id TEXT,
  private_reply_message_id TEXT,
  private_reply_recipient_id TEXT,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (channel, comment_id)
);

CREATE INDEX IF NOT EXISTS idx_meta_comment_automation_recovery
  ON meta_comment_automation_jobs (status, next_attempt_at, updated_at)
  WHERE status IN ('pending', 'processing', 'failed');
