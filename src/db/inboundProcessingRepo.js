const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");

const MAX_INCOMING_PAYLOAD_BYTES = 128 * 1024;

const MESSAGE_COLUMNS = `
  id,
  contact_id,
  role,
  content,
  whatsapp_message_id,
  sent_by_username,
  media_url,
  (media_key IS NOT NULL) AS has_media_attachment,
  media_mime_type,
  created_at,
  delivery_status,
  delivery_error,
  is_automated_follow_up
`;

const JOB_COLUMNS = `
  id,
  message_id,
  contact_id,
  channel,
  incoming_payload,
  status,
  attempts,
  prepared_at,
  was_first_message,
  claimed_at,
  completed_at,
  last_error,
  created_at,
  updated_at
`;

function serializeIncoming(incoming) {
  const json = JSON.stringify(incoming || {});
  if (Buffer.byteLength(json, "utf8") > MAX_INCOMING_PAYLOAD_BYTES) {
    throw new Error("Inbound processing payload is unexpectedly large.");
  }
  return json;
}

/**
 * Atomically stores the inbound customer message and the durable processing
 * job that represents the remaining reply work. A Meta retry races safely on
 * messages.whatsapp_message_id: exactly one INSERT wins and only that winner
 * receives a processing job.
 */
async function storeInboundClaim({
  contactId,
  content,
  storedMessageId,
  channel,
  incoming,
}, database = pool) {
  const payload = serializeIncoming(incoming);
  const result = await database.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     ), inserted_message AS (
       INSERT INTO messages (
         contact_id, role, content, whatsapp_message_id
       )
       SELECT $1, 'user', $2, $3
       FROM conversation_lock
       ON CONFLICT (whatsapp_message_id) DO NOTHING
       RETURNING ${MESSAGE_COLUMNS}
     ), inserted_job AS (
       INSERT INTO inbound_processing_jobs (
         message_id, contact_id, channel, incoming_payload
       )
       SELECT id, contact_id, $4, $5::jsonb
       FROM inserted_message
       RETURNING ${JOB_COLUMNS}
     )
     SELECT
       row_to_json(m.*) AS saved_inbound,
       row_to_json(j.*) AS processing_job
     FROM inserted_message m
     JOIN inserted_job j ON j.message_id = m.id`,
    [contactId, content, storedMessageId, channel, payload]
  );

  const row = result.rows[0];
  if (!row) return null;
  return {
    savedInbound: row.saved_inbound,
    processingJob: row.processing_job,
  };
}

async function markPrepared(messageId, wasFirstMessage, database = pool) {
  const result = await database.query(
    `UPDATE inbound_processing_jobs
     SET prepared_at = COALESCE(prepared_at, NOW()),
         was_first_message = COALESCE(was_first_message, $2),
         updated_at = NOW()
     WHERE message_id = $1 AND status <> 'completed'
     RETURNING ${JOB_COLUMNS}`,
    [messageId, Boolean(wasFirstMessage)]
  );
  return result.rows[0] || null;
}

async function claimPendingByMessageId(messageId, database = pool) {
  const result = await database.query(
    `UPDATE inbound_processing_jobs
     SET status = 'processing',
         attempts = attempts + 1,
         claimed_at = NOW(),
         last_error = NULL,
         updated_at = NOW()
     WHERE message_id = $1 AND status = 'pending'
     RETURNING ${JOB_COLUMNS}`,
    [messageId]
  );
  return result.rows[0] || null;
}

async function claimRecoverable({
  limit = 25,
  staleAfterSeconds = 45,
  maxAttempts = 5,
} = {}, database = pool) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const safeStaleSeconds = Math.max(5, Math.min(3600, Number(staleAfterSeconds) || 45));
  const safeMaxAttempts = Math.max(1, Math.min(20, Number(maxAttempts) || 5));

  const result = await database.query(
    `WITH eligible AS (
       SELECT id
       FROM inbound_processing_jobs
       WHERE attempts < $3
         AND (
           status = 'pending'
           OR status = 'failed'
           OR (
             status = 'processing'
             AND claimed_at < NOW() - ($2::int * interval '1 second')
           )
         )
       ORDER BY created_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     )
     UPDATE inbound_processing_jobs j
     SET status = 'processing',
         attempts = j.attempts + 1,
         claimed_at = NOW(),
         last_error = NULL,
         updated_at = NOW()
     FROM eligible
     WHERE j.id = eligible.id
     RETURNING j.*`,
    [safeLimit, safeStaleSeconds, safeMaxAttempts]
  );
  return result.rows;
}

async function markCompleted(jobId, database = pool) {
  const result = await database.query(
    `UPDATE inbound_processing_jobs
     SET status = 'completed',
         completed_at = NOW(),
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1 AND status <> 'completed'
     RETURNING ${JOB_COLUMNS}`,
    [jobId]
  );
  return result.rows[0] || null;
}

async function markCompletedByMessageId(messageId, database = pool) {
  const result = await database.query(
    `UPDATE inbound_processing_jobs
     SET status = 'completed',
         completed_at = NOW(),
         last_error = NULL,
         updated_at = NOW()
     WHERE message_id = $1 AND status <> 'completed'
     RETURNING ${JOB_COLUMNS}`,
    [messageId]
  );
  return result.rows[0] || null;
}

async function markFailed(jobId, error, database = pool) {
  const text = String(error?.message || error || "Inbound processing failed.").slice(0, 1000);
  const result = await database.query(
    `UPDATE inbound_processing_jobs
     SET status = 'failed',
         last_error = $2,
         updated_at = NOW()
     WHERE id = $1 AND status <> 'completed'
     RETURNING ${JOB_COLUMNS}`,
    [jobId, text]
  );
  return result.rows[0] || null;
}

async function getJobContext(jobId, database = pool) {
  const result = await database.query(
    `SELECT
       j.*,
       row_to_json(m.*) AS saved_inbound,
       NOT EXISTS (
         SELECT 1
         FROM messages earlier
         WHERE earlier.contact_id = m.contact_id
           AND earlier.id < m.id
       ) AS derived_first_message
     FROM inbound_processing_jobs j
     JOIN LATERAL (
       SELECT ${MESSAGE_COLUMNS}
       FROM messages
       WHERE id = j.message_id AND contact_id = j.contact_id AND role = 'user'
     ) m ON true
     WHERE j.id = $1`,
    [jobId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    job: {
      id: row.id,
      message_id: row.message_id,
      contact_id: row.contact_id,
      channel: row.channel,
      incoming_payload: row.incoming_payload,
      status: row.status,
      attempts: row.attempts,
      prepared_at: row.prepared_at,
      was_first_message: row.was_first_message,
      claimed_at: row.claimed_at,
      completed_at: row.completed_at,
      last_error: row.last_error,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    savedInbound: row.saved_inbound,
    derivedFirstMessage: Boolean(row.derived_first_message),
  };
}

async function pruneCompleted({ olderThanHours = 24 } = {}, database = pool) {
  const hours = Math.max(1, Math.min(24 * 30, Number(olderThanHours) || 24));
  const result = await database.query(
    `DELETE FROM inbound_processing_jobs
     WHERE status = 'completed'
       AND completed_at < NOW() - ($1::int * interval '1 hour')`,
    [hours]
  );
  return result.rowCount || 0;
}

module.exports = {
  MAX_INCOMING_PAYLOAD_BYTES,
  claimPendingByMessageId,
  claimRecoverable,
  getJobContext,
  markCompleted,
  markCompletedByMessageId,
  markFailed,
  markPrepared,
  pruneCompleted,
  serializeIncoming,
  storeInboundClaim,
};
