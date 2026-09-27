ALTER TABLE meta_comment_automation_jobs
  ADD COLUMN IF NOT EXISTS private_reply_pending_text TEXT,
  ADD COLUMN IF NOT EXISTS private_reply_pending_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_meta_comment_private_reply_pending
  ON meta_comment_automation_jobs (
    channel,
    author_id,
    private_reply_pending_at DESC
  )
  WHERE private_reply_message_id IS NULL
    AND private_reply_pending_at IS NOT NULL
    AND status = 'processing';
