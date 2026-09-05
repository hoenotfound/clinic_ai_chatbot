const crypto = require("crypto");
const { pool } = require("./db");

const SUPPORTED_STATUSES = new Set(["sent", "delivered", "read", "failed"]);

function cleanNullable(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeUpdate(update) {
  const wamid = cleanNullable(update?.wamid);
  const deliveryStatus = cleanNullable(update?.status)?.toLowerCase() || null;
  if (!wamid || !SUPPORTED_STATUSES.has(deliveryStatus)) return null;

  const normalized = {
    wamid,
    deliveryStatus,
    errorCode: cleanNullable(update?.errorCode),
    errorTitle: cleanNullable(update?.errorTitle),
    errorMessage: cleanNullable(update?.errorMessage),
  };
  normalized.eventKey = crypto
    .createHash("sha256")
    .update([
      normalized.wamid,
      normalized.deliveryStatus,
      normalized.errorCode || "",
      normalized.errorTitle || "",
      normalized.errorMessage || "",
    ].join("\0"))
    .digest("hex");
  return normalized;
}

async function storeBatch(updates, query = pool.query.bind(pool)) {
  const normalized = (updates || []).map(normalizeUpdate).filter(Boolean);
  if (!normalized.length) return [];

  const values = [];
  const placeholders = normalized.map((item, index) => {
    const offset = index * 6;
    values.push(
      item.eventKey,
      item.wamid,
      item.deliveryStatus,
      item.errorCode,
      item.errorTitle,
      item.errorMessage
    );
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}, $${offset + 6})`;
  });

  const result = await query(
    `INSERT INTO whatsapp_delivery_status_jobs (
       event_key, wamid, delivery_status, error_code, error_title, error_message
     )
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (event_key) DO NOTHING
     RETURNING *`,
    values
  );
  return result.rows;
}

async function claimByIds(ids, query = pool.query.bind(pool)) {
  const cleanIds = (ids || [])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0);
  if (!cleanIds.length) return [];

  const result = await query(
    `WITH candidates AS (
       SELECT id
       FROM whatsapp_delivery_status_jobs
       WHERE id = ANY($1::bigint[])
         AND terminal_at IS NULL
         AND processing_status IN ('pending', 'failed')
       ORDER BY created_at, id
       FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_delivery_status_jobs job
     SET processing_status = 'processing',
         attempts = job.attempts + 1,
         claimed_at = NOW(),
         last_error = NULL,
         updated_at = NOW()
     FROM candidates
     WHERE job.id = candidates.id
     RETURNING job.*`,
    [cleanIds]
  );
  return result.rows;
}

async function claimRecoverable(
  { limit = 50, staleAfterSeconds = 60, maxAttempts = 5 } = {},
  query = pool.query.bind(pool)
) {
  const result = await query(
    `WITH candidates AS (
       SELECT id
       FROM whatsapp_delivery_status_jobs
       WHERE terminal_at IS NULL
         AND attempts < $3
         AND (
           processing_status IN ('pending', 'failed')
           OR (
             processing_status = 'processing'
             AND claimed_at < NOW() - ($2::integer * interval '1 second')
           )
         )
       ORDER BY created_at, id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE whatsapp_delivery_status_jobs job
     SET processing_status = 'processing',
         attempts = job.attempts + 1,
         claimed_at = NOW(),
         last_error = NULL,
         updated_at = NOW()
     FROM candidates
     WHERE job.id = candidates.id
     RETURNING job.*`,
    [limit, staleAfterSeconds, maxAttempts]
  );
  return result.rows;
}

async function listExhausted(
  { limit = 50, staleAfterSeconds = 60, maxAttempts = 5 } = {},
  query = pool.query.bind(pool)
) {
  const result = await query(
    `SELECT *
     FROM whatsapp_delivery_status_jobs
     WHERE terminal_at IS NULL
       AND processing_status <> 'completed'
       AND attempts >= $3
       AND (
         processing_status <> 'processing'
         OR claimed_at < NOW() - ($2::integer * interval '1 second')
       )
     ORDER BY created_at, id
     LIMIT $1`,
    [limit, staleAfterSeconds, maxAttempts]
  );
  return result.rows;
}

async function markCompleted(id, query = pool.query.bind(pool)) {
  const result = await query(
    `UPDATE whatsapp_delivery_status_jobs
     SET processing_status = 'completed',
         completed_at = NOW(),
         claimed_at = NULL,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND terminal_at IS NULL
       AND processing_status <> 'completed'
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

async function markFailed(id, error, query = pool.query.bind(pool)) {
  const message = String(error?.message || error || "Delivery-status processing failed.").slice(0, 1000);
  const result = await query(
    `UPDATE whatsapp_delivery_status_jobs
     SET processing_status = 'failed',
         claimed_at = NULL,
         last_error = $2,
         updated_at = NOW()
     WHERE id = $1
       AND terminal_at IS NULL
       AND processing_status <> 'completed'
     RETURNING *`,
    [id, message]
  );
  return result.rows[0] || null;
}

async function markTerminal(id, query = pool.query.bind(pool)) {
  const result = await query(
    `UPDATE whatsapp_delivery_status_jobs
     SET processing_status = 'failed',
         claimed_at = NULL,
         terminal_at = COALESCE(terminal_at, NOW()),
         updated_at = NOW()
     WHERE id = $1
       AND terminal_at IS NULL
       AND processing_status <> 'completed'
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

async function findMessageByWamid(wamid, query = pool.query.bind(pool)) {
  const result = await query(
    `SELECT id, contact_id, whatsapp_message_id, delivery_status, delivery_error
     FROM messages
     WHERE whatsapp_message_id = $1
     LIMIT 1`,
    [wamid]
  );
  return result.rows[0] || null;
}

// Durable delivery-status recovery must be able to restore the Inbox attention
// flag without replaying contactsRepo's best-effort Telegram side effect. This
// mirrors contactsRepo.setDeliveryAttention's precedence rules while keeping the
// durable database mutation independent from external notification delivery.
async function setDeliveryAttentionState(
  contactId,
  reason,
  query = pool.query.bind(pool)
) {
  const result = await query(
    `UPDATE contacts
     SET needs_attention = true, attention_reason = $1, updated_at = now()
     WHERE id = $2
       AND (
         needs_attention = false
         OR attention_reason IS NULL
         OR attention_reason LIKE 'Delivery failed:%'
         OR attention_reason LIKE 'Delivery unconfirmed:%'
       )
       AND (
         needs_attention IS DISTINCT FROM true
         OR attention_reason IS DISTINCT FROM $1
       )
     RETURNING id`,
    [reason, contactId]
  );
  return result.rows[0] || null;
}

async function pruneCompleted({ olderThanHours = 24 } = {}, query = pool.query.bind(pool)) {
  const result = await query(
    `DELETE FROM whatsapp_delivery_status_jobs
     WHERE processing_status = 'completed'
       AND completed_at < NOW() - ($1::integer * interval '1 hour')`,
    [olderThanHours]
  );
  return result.rowCount || 0;
}

module.exports = {
  SUPPORTED_STATUSES,
  normalizeUpdate,
  storeBatch,
  claimByIds,
  claimRecoverable,
  listExhausted,
  markCompleted,
  markFailed,
  markTerminal,
  findMessageByWamid,
  setDeliveryAttentionState,
  pruneCompleted,
};
