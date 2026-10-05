const crypto = require("crypto");
const { pool } = require("./db");

const RETRY_COLUMNS = `
  id,
  message_id,
  contact_id,
  recipient,
  origin,
  status,
  processing_kind,
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

function nullableInteger(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
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
       status,
       processing_kind,
       next_attempt_at,
       last_error,
       provider_status,
       provider_error_code,
       completed_at
     )
     VALUES (
       $1, $2, $3, $4,
       'scheduled', NULL,
       NOW() + ($5::int * interval '1 second'),
       $6, $7, $8, NULL
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
      nullableInteger(providerStatus),
      nullableInteger(providerErrorCode),
    ]
  );
  return result.rows[0] || null;
}

async function enqueueDeliveryFailureRetry({
  messageId,
  contactId,
  delaySeconds = 15,
  errorText = null,
  providerErrorCode = null,
  maxAttempts = 3,
}, database = pool) {
  const safeMessageId = Number(messageId);
  const safeContactId = Number(contactId);
  const safeMaxAttempts = Math.max(1, Math.min(10, Number(maxAttempts) || 3));
  const result = await database.query(
    `WITH source AS (
       SELECT
         m.id AS message_id,
         c.id AS contact_id,
         c.whatsapp_number AS recipient,
         a.origin
       FROM messages m
       JOIN contacts c ON c.id = m.contact_id
       JOIN inbound_outbound_attempts a ON a.assistant_message_id = m.id
       WHERE m.id = $1
         AND m.contact_id = $2
         AND c.channel = 'whatsapp'
         AND m.role = 'assistant'
         AND m.sent_by_username IS NULL
         AND m.media_url IS NULL
         AND a.origin IN ('ai_reply', 'system_fallback')
       LIMIT 1
     ), upserted AS (
       INSERT INTO whatsapp_outbound_retries (
         message_id,
         contact_id,
         recipient,
         origin,
         status,
         processing_kind,
         next_attempt_at,
         last_error,
         provider_error_code,
         completed_at
       )
       SELECT
         source.message_id,
         source.contact_id,
         source.recipient,
         source.origin,
         'scheduled',
         NULL,
         NOW() + ($3::int * interval '1 second'),
         $4,
         $5,
         NULL
       FROM source
       ON CONFLICT (message_id) DO UPDATE
       SET status = 'scheduled',
           processing_kind = NULL,
           next_attempt_at = EXCLUDED.next_attempt_at,
           claimed_at = NULL,
           lease_token = NULL,
           last_error = EXCLUDED.last_error,
           provider_error_code = EXCLUDED.provider_error_code,
           completed_at = NULL,
           updated_at = NOW()
       WHERE whatsapp_outbound_retries.status = 'sent'
         AND whatsapp_outbound_retries.attempts < $6
       RETURNING ${RETRY_COLUMNS}
     )
     SELECT * FROM upserted
     UNION ALL
     SELECT ${RETRY_COLUMNS}
     FROM whatsapp_outbound_retries
     WHERE message_id = $1
       AND status IN ('scheduled', 'processing')
       AND NOT EXISTS (SELECT 1 FROM upserted)
     LIMIT 1`,
    [
      safeMessageId,
      safeContactId,
      safeDelaySeconds(delaySeconds),
      errorText ? String(errorText).slice(0, 1000) : null,
      nullableInteger(providerErrorCode),
      safeMaxAttempts,
    ]
  );
  return result.rows[0] || null;
}

async function claimDue({ limit = 10 } = {}, database = pool) {
  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 10));
  const leaseToken = crypto.randomUUID();
  const result = await database.query(
    `WITH eligible AS (
       SELECT id, status AS source_status
       FROM whatsapp_outbound_retries
       WHERE status IN ('scheduled', 'attention_pending')
         AND next_attempt_at <= NOW()
       ORDER BY next_attempt_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1
     ), claimed AS (
       UPDATE whatsapp_outbound_retries q
       SET status = 'processing',
           processing_kind = CASE
             WHEN eligible.source_status = 'attention_pending' THEN 'attention'
             ELSE 'send_pending'
           END,
           attempts = q.attempts + CASE
             WHEN eligible.source_status = 'scheduled' THEN 1
             ELSE 0
           END,
           claimed_at = NOW(),
           lease_token = $2,
           updated_at = NOW()
       FROM eligible
       WHERE q.id = eligible.id
       RETURNING q.*, eligible.source_status AS claimed_from_status
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
       c.needs_attention AS contact_needs_attention,
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

async function checkSendEligibility({
  id,
  leaseToken,
  messageId,
  contactId,
} = {}, database = pool) {
  const result = await database.query(
    `SELECT
       q.id,
       q.status,
       q.processing_kind,
       q.lease_token,
       c.id AS contact_id,
       c.mode AS contact_mode,
       c.channel AS contact_channel,
       c.whatsapp_number AS current_recipient,
       c.needs_attention AS contact_needs_attention,
       EXISTS (
         SELECT 1
         FROM messages newer
         JOIN messages original ON original.id = $3
         WHERE newer.contact_id = original.contact_id
           AND newer.role = 'user'
           AND (newer.created_at, newer.id) > (original.created_at, original.id)
       ) AS has_newer_customer_message,
       EXISTS (
         SELECT 1
         FROM messages newer
         JOIN messages original ON original.id = $3
         WHERE newer.contact_id = original.contact_id
           AND newer.role = 'assistant'
           AND newer.sent_by_username IS NOT NULL
           AND COALESCE(newer.delivery_status, 'pending') <> 'failed'
           AND (newer.created_at, newer.id) > (original.created_at, original.id)
       ) AS has_newer_staff_message
     FROM whatsapp_outbound_retries q
     JOIN contacts c ON c.id = q.contact_id
     WHERE q.id = $1
       AND q.lease_token = $2
       AND q.message_id = $3
       AND q.contact_id = $4
       AND q.status = 'processing'
       AND q.processing_kind = 'send_pending'`,
    [
      Number(id),
      String(leaseToken || ""),
      Number(messageId),
      Number(contactId),
    ]
  );
  return result.rows[0] || null;
}

async function markSendStarted(id, leaseToken, database = pool) {
  const result = await database.query(
    `UPDATE whatsapp_outbound_retries
     SET processing_kind = 'send_started',
         updated_at = NOW()
     WHERE id = $1
       AND status = 'processing'
       AND processing_kind = 'send_pending'
       AND lease_token = $2
     RETURNING ${RETRY_COLUMNS}`,
    [Number(id), String(leaseToken || "")]
  );
  return result.rows[0] || null;
}

async function prepareAttention(id, leaseToken, reason, database = pool) {
  const result = await database.query(
    `UPDATE whatsapp_outbound_retries
     SET processing_kind = 'attention',
         last_error = $3,
         updated_at = NOW()
     WHERE id = $1
       AND status = 'processing'
       AND lease_token = $2
     RETURNING ${RETRY_COLUMNS}`,
    [
      Number(id),
      String(leaseToken || ""),
      String(reason || "").slice(0, 1000),
    ]
  );
  return result.rows[0] || null;
}

async function deferAttention(
  id,
  leaseToken,
  reason,
  { delaySeconds = 60 } = {},
  database = pool
) {
  const result = await database.query(
    `UPDATE whatsapp_outbound_retries
     SET status = 'attention_pending',
         processing_kind = NULL,
         next_attempt_at = NOW() + ($4::int * interval '1 second'),
         claimed_at = NULL,
         lease_token = NULL,
         last_error = $3,
         updated_at = NOW()
     WHERE id = $1
       AND status = 'processing'
       AND lease_token = $2
     RETURNING ${RETRY_COLUMNS}`,
    [
      Number(id),
      String(leaseToken || ""),
      String(reason || "").slice(0, 1000),
      safeDelaySeconds(delaySeconds),
    ]
  );
  return result.rows[0] || null;
}

async function recoverStaleProcessing({
  staleAfterSeconds = 180,
  limit = 25,
} = {}, database = pool) {
  const safeStale = Math.max(30, Math.min(3600, Number(staleAfterSeconds) || 180));
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
  const leaseToken = crypto.randomUUID();

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
       SET claimed_at = NOW(),
           lease_token = $3,
           updated_at = NOW()
       FROM stale
       WHERE q.id = stale.id
       RETURNING q.*
     )
     SELECT
       recovered.*,
       m.content AS message_content,
       m.whatsapp_message_id,
       m.delivery_status,
       m.delivery_error
     FROM recovered
     JOIN messages m ON m.id = recovered.message_id`,
    [safeStale, safeLimit, leaseToken]
  );
  return result.rows;
}

async function markSent(id, leaseToken, database = pool) {
  const result = await database.query(
    `UPDATE whatsapp_outbound_retries
     SET status = 'sent',
         processing_kind = NULL,
         claimed_at = NULL,
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
         processing_kind = NULL,
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
      nullableInteger(providerStatus),
      nullableInteger(providerErrorCode),
    ]
  );
  return result.rows[0] || null;
}

async function markFailed(id, leaseToken, errorText, database = pool) {
  const result = await database.query(
    `UPDATE whatsapp_outbound_retries
     SET status = 'failed',
         processing_kind = NULL,
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
         processing_kind = NULL,
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

async function findNextDueAt({
  staleAfterSeconds = 180,
} = {}, database = pool) {
  const safeStale = Math.max(30, Math.min(3600, Number(staleAfterSeconds) || 180));
  const result = await database.query(
    `SELECT LEAST(
       (
         SELECT MIN(next_attempt_at)
         FROM whatsapp_outbound_retries
         WHERE status IN ('scheduled', 'attention_pending')
       ),
       (
         SELECT MIN(COALESCE(claimed_at, NOW()) + ($1::int * interval '1 second'))
         FROM whatsapp_outbound_retries
         WHERE status = 'processing'
       )
     ) AS next_due_at`,
    [safeStale]
  );
  return result.rows[0]?.next_due_at || null;
}

module.exports = {
  checkSendEligibility,
  claimDue,
  deferAttention,
  enqueueDeliveryFailureRetry,
  enqueueTextRetry,
  findNextDueAt,
  markCancelled,
  markFailed,
  markSendStarted,
  markSent,
  nullableInteger,
  prepareAttention,
  recoverStaleProcessing,
  reschedule,
};
