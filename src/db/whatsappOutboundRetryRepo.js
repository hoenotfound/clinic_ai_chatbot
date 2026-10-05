const crypto = require("crypto");
const { pool } = require("./db");

const RETRY_COLUMNS = `
  id,
  message_id,
  contact_id,
  recipient,
  origin,
  status,
  attempts,
  next_attempt_at,
  claimed_at,
  lease_token,
  last_error,
  provider_status,
  provider_error_code,
  completed_at,
  created_at,
  updated_at
`;

function safeDelaySeconds(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.min(24 * 60 * 60, Math.round(seconds))
    : 0;
}

async function enqueueTextRetry({
  messageId,
  contactId,
  recipient,
  origin,
  delaySeconds = 15,
  errorText = null,
  providerStatus = null,
  providerErrorCode = null,
}, database = pool) {
  const result = await database.query(
    `INSERT INTO whatsapp_outbound_retries (
       message_id,
       contact_id,
       recipient,
       origin,
       next_attempt_at,
       last_error,
       provider_status,
       provider_error_code
     )
     VALUES (
       $1, $2, $3, $4,
       NOW() + ($5::int * interval '1 second'),
       $6, $7, $8
     )
     ON CONFLICT (message_id) DO UPDATE
     SET last_error = EXCLUDED.last_error,
         provider_status = EXCLUDED.provider_status,
         provider_error_code = EXCLUDED.provider_error_code,
         updated_at = NOW()
     RETURNING ${RETRY_COLUMNS}`,
    [
      Number(messageId),
      Number(contactId),
      String(recipient || "").trim(),
      String(origin || "").trim(),
      safeDelaySeconds(delaySeconds),
      errorText ? String(errorText).slice(0, 1000) : null,
      Number.isInteger(Number(providerStatus)) ? Number(providerStatus) : null,
      Number.isInteger(Number(providerErrorCode)) ? Number(providerErrorCode) : null,
    ]
  );
  return result.rows[0] || null;
}

async function claimDue({ limit = 10 } = {}, database = pool) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const leaseToken = crypto.randomUUID();
  const result = await database.query(
    `WITH eligible AS (
       SELECT id
       FROM whatsapp_outbound_retries
       WHERE status = 'scheduled'
         AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     ), claimed AS (
       UPDATE whatsapp_outbound_retries q
       SET status = 'processing',
           attempts = q.attempts + 1,
           claimed_at = NOW(),
           lease_token = $2,
           updated_at = NOW()
       FROM eligible
       WHERE q.id = eligible.id
       RETURNING q.*
     )
     SELECT
       claimed.*,
       m.content AS message_content,
       m.delivery_status,
       m.delivery_error,
       m.whatsapp_message_id,
       m.created_at AS message_created_at,
       c.mode AS contact_mode,
       c.channel AS contact_channel,
       c.whatsapp_number AS current_recipient,
       EXISTS (
         SELECT 1
         FROM messages newer
         WHERE newer.contact_id = m.contact_id
           AND newer.role = 'user'
           AND (newer.created_at, newer.id) > (m.created_at, m.id)
       ) AS has_newer_customer_message,
       EXISTS (
         SELECT 1
         FROM messages newer
         WHERE newer.contact_id = m.contact_id
           AND newer.role = 'assistant'
           AND newer.sent_by_username IS NOT NULL
           AND COALESCE(newer.delivery_status, 'pending') <> 'failed'
           AND (newer.created_at, newer.id) > (m.created_at, m.id)
       ) AS has_newer_staff_message
     FROM claimed
     JOIN messages m ON m.id = claimed.message_id
     JOIN contacts c ON c.id = claimed.contact_id
     ORDER BY claimed.next_attempt_at ASC, claimed.id ASC`,
    [safeLimit, leaseToken]
  );
  return result.rows;
}

async function recoverStaleProcessing({
  staleAfterSeconds = 180,
  limit = 25,
} = {}, database = pool) {
  const safeStale = Math.max(30, Math.min(3600, Number(staleAfterSeconds) || 180));
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const reason =
    "Delivery could not be confirmed because the server restarted during an automatic WhatsApp retry.";

  const result = await database.query(
    `WITH stale AS (
       SELECT id
       FROM whatsapp_outbound_retries
       WHERE status = 'processing'
         AND (
           claimed_at IS NULL
           OR claimed_at < NOW() - ($1::int * interval '1 second')
         )
       ORDER BY claimed_at ASC NULLS FIRST, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     ), recovered AS (
       UPDATE whatsapp_outbound_retries q
       SET status = 'failed',
           last_error = $3,
           lease_token = NULL,
           completed_at = COALESCE(completed_at, NOW()),
           updated_at = NOW()
       FROM stale
       WHERE q.id = stale.id
       RETURNING q.*
     )
     SELECT recovered.*, m.content AS message_content
     FROM recovered
     JOIN messages m ON m.id = recovered.message_id`,
    [safeStale, safeLimit, reason]
  );
  return result.rows;
}

async function markSent(id, leaseToken, database = pool) {
  const result = await database.query(
    `UPDATE whatsapp_outbound_retries
     SET status = 'sent',
         lease_token = NULL,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'processing'
       AND lease_token = $2
     RETURNING ${RETRY_COLUMNS}`,
    [Number(id), String(leaseToken || "")]
  );
  return result.rows[0] || null;
}

async function reschedule(id, leaseToken, {
  delaySeconds,
  errorText = null,
  providerStatus = null,
  providerErrorCode = null,
} = {}, database = pool) {
  const result = await database.query(
    `UPDATE whatsapp_outbound_retries
     SET status = 'scheduled',
         next_attempt_at = NOW() + ($3::int * interval '1 second'),
         claimed_at = NULL,
         lease_token = NULL,
         last_error = $4,
         provider_status = $5,
         provider_error_code = $6,
         updated_at = NOW()
     WHERE id = $1
       AND status = 'processing'
       AND lease_token = $2
     RETURNING ${RETRY_COLUMNS}`,
    [
      Number(id),
      String(leaseToken || ""),
      safeDelaySeconds(delaySeconds),
      errorText ? String(errorText).slice(0, 1000) : null,
      Number.isInteger(Number(providerStatus)) ? Number(providerStatus) : null,
      Number.isInteger(Number(providerErrorCode)) ? Number(providerErrorCode) : null,
    ]
  );
  return result.rows[0] || null;
}

async function markFailed(id, leaseToken, errorText, database = pool) {
  const result = await database.query(
    `UPDATE whatsapp_outbound_retries
     SET status = 'failed',
         claimed_at = NULL,
         lease_token = NULL,
         last_error = $3,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'processing'
       AND lease_token = $2
     RETURNING ${RETRY_COLUMNS}`,
    [Number(id), String(leaseToken || ""), String(errorText || "").slice(0, 1000)]
  );
  return result.rows[0] || null;
}

async function markCancelled(id, leaseToken, reason, database = pool) {
  const result = await database.query(
    `UPDATE whatsapp_outbound_retries
     SET status = 'cancelled',
         claimed_at = NULL,
         lease_token = NULL,
         last_error = $3,
         completed_at = NOW(),
         updated_at = NOW()
     WHERE id = $1
       AND status = 'processing'
       AND lease_token = $2
     RETURNING ${RETRY_COLUMNS}`,
    [Number(id), String(leaseToken || ""), String(reason || "").slice(0, 1000)]
  );
  return result.rows[0] || null;
}

async function findNextDueAt(database = pool) {
  const result = await database.query(
    `SELECT MIN(next_attempt_at) AS next_due_at
     FROM whatsapp_outbound_retries
     WHERE status = 'scheduled'`
  );
  return result.rows[0]?.next_due_at || null;
}

module.exports = {
  claimDue,
  enqueueTextRetry,
  findNextDueAt,
  markCancelled,
  markFailed,
  markSent,
  recoverStaleProcessing,
  reschedule,
};
