const { pool } = require("./db");

const MAX_ATTEMPTS = 8;
const STALE_PROCESSING_MINUTES = 10;

function rowToJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    channel: row.channel,
    commentId: row.comment_id,
    entryId: row.entry_id,
    authorId: row.author_id,
    authorName: row.author_name,
    text: row.comment_text,
    postId: row.post_id,
    mediaId: row.media_id,
    parentCommentId: row.parent_comment_id,
    sourceCreatedAt: row.source_created_at || null,
    rawEvent: row.raw_event || {},
    status: row.status,
    attemptCount: Number(row.attempt_count || 0),
    nextAttemptAt: row.next_attempt_at || null,
    publicReplyId: row.public_reply_id || null,
    privateReplyMessageId: row.private_reply_message_id || null,
    privateReplyRecipientId: row.private_reply_recipient_id || null,
    lastError: row.last_error || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    completedAt: row.completed_at || null,
  };
}

async function storeIncomingComment(event, database = pool) {
  const result = await database.query(
    `INSERT INTO meta_comment_automation_jobs (
       channel, comment_id, entry_id, author_id, author_name, comment_text,
       post_id, media_id, parent_comment_id, source_created_at, raw_event
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (channel, comment_id) DO NOTHING
     RETURNING *`,
    [
      event.channel,
      event.commentId,
      event.entryId,
      event.authorId || null,
      event.authorName || null,
      event.text,
      event.postId || null,
      event.mediaId || null,
      event.parentCommentId || null,
      event.createdAt || null,
      event.rawEvent || {},
    ]
  );
  return rowToJob(result.rows[0]);
}

async function claimJob(id, database = pool) {
  const result = await database.query(
    `UPDATE meta_comment_automation_jobs
     SET status = 'processing',
         attempt_count = attempt_count + 1,
         updated_at = now(),
         last_error = NULL
     WHERE id = $1
       AND attempt_count < $2
       AND (
         (status IN ('pending', 'failed') AND next_attempt_at <= now())
         OR
         (status = 'processing' AND updated_at <= now() - ($3 * INTERVAL '1 minute'))
       )
     RETURNING *`,
    [id, MAX_ATTEMPTS, STALE_PROCESSING_MINUTES]
  );
  return rowToJob(result.rows[0]);
}

async function listRecoverable(limit = 20, database = pool) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 20, 100));
  const result = await database.query(
    `SELECT *
     FROM meta_comment_automation_jobs
     WHERE attempt_count < $2
       AND (
         (status IN ('pending', 'failed') AND next_attempt_at <= now())
         OR
         (status = 'processing' AND updated_at <= now() - ($3 * INTERVAL '1 minute'))
       )
     ORDER BY next_attempt_at ASC, id ASC
     LIMIT $1`,
    [safeLimit, MAX_ATTEMPTS, STALE_PROCESSING_MINUTES]
  );
  return result.rows.map(rowToJob);
}

async function markPublicReplySent(id, replyId, database = pool) {
  const result = await database.query(
    `UPDATE meta_comment_automation_jobs
     SET public_reply_id = COALESCE(public_reply_id, $2),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, replyId || "sent"]
  );
  return rowToJob(result.rows[0]);
}

async function markPrivateReplySent(
  id,
  { messageId = null, recipientId = null } = {},
  database = pool
) {
  const result = await database.query(
    `UPDATE meta_comment_automation_jobs
     SET private_reply_message_id = COALESCE(private_reply_message_id, $2),
         private_reply_recipient_id = COALESCE(private_reply_recipient_id, $3),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, messageId || "sent", recipientId]
  );
  return rowToJob(result.rows[0]);
}

async function markCompleted(id, database = pool) {
  const result = await database.query(
    `UPDATE meta_comment_automation_jobs
     SET status = 'completed',
         completed_at = now(),
         updated_at = now(),
         last_error = NULL
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return rowToJob(result.rows[0]);
}

async function markSkipped(id, reason, database = pool) {
  const result = await database.query(
    `UPDATE meta_comment_automation_jobs
     SET status = 'skipped',
         completed_at = now(),
         updated_at = now(),
         last_error = $2
     WHERE id = $1
     RETURNING *`,
    [id, String(reason || "Skipped.").slice(0, 1000)]
  );
  return rowToJob(result.rows[0]);
}

async function markFailed(id, error, attemptCount = 1, database = pool) {
  const boundedAttempt = Math.max(1, Number(attemptCount) || 1);
  const retrySeconds = Math.min(3600, 15 * 2 ** Math.min(8, boundedAttempt - 1));
  const message = String(error?.message || error || "Comment automation failed.").slice(0, 2000);
  const result = await database.query(
    `UPDATE meta_comment_automation_jobs
     SET status = 'failed',
         last_error = $2,
         next_attempt_at = now() + ($3 * INTERVAL '1 second'),
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id, message, retrySeconds]
  );
  return rowToJob(result.rows[0]);
}

module.exports = {
  MAX_ATTEMPTS,
  STALE_PROCESSING_MINUTES,
  claimJob,
  listRecoverable,
  markCompleted,
  markFailed,
  markPrivateReplySent,
  markPublicReplySent,
  markSkipped,
  rowToJob,
  storeIncomingComment,
};
