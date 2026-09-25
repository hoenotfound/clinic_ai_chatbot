const crypto = require("crypto");
const { pool } = require("./db");

const MAX_HISTORY_PAYLOAD_BYTES = 5 * 1024 * 1024;

function newLeaseToken() {
  return crypto.randomBytes(16).toString("hex");
}

function normalizeRecords(records) {
  return (records || []).filter((record) => record?.id && record?.peer);
}

function eventKeyForHistory(records) {
  const ids = normalizeRecords(records)
    .map((record) => String(record.id))
    .sort();
  if (!ids.length) return null;
  return crypto.createHash("sha256").update(ids.join("\0")).digest("hex");
}

function serializePayload(records) {
  const normalized = normalizeRecords(records);
  const json = JSON.stringify({ records: normalized });
  if (Buffer.byteLength(json, "utf8") > MAX_HISTORY_PAYLOAD_BYTES) {
    const err = new Error("WhatsApp coexistence history payload is unexpectedly large.");
    err.code = "COEXISTENCE_HISTORY_PAYLOAD_TOO_LARGE";
    throw err;
  }
  return json;
}

async function store(records, query = pool.query.bind(pool)) {
  const eventKey = eventKeyForHistory(records);
  if (!eventKey) return null;
  const payload = serializePayload(records);

  const inserted = await query(
    `INSERT INTO whatsapp_coexistence_history_jobs (event_key, payload)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING *`,
    [eventKey, payload]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  const existing = await query(
    `SELECT *
     FROM whatsapp_coexistence_history_jobs
     WHERE event_key = $1
     LIMIT 1`,
    [eventKey]
  );
  return existing.rows[0] || null;
}

async function claimById(id, query = pool.query.bind(pool)) {
  const safeId = Number(id);
  if (!Number.isSafeInteger(safeId) || safeId < 1) return null;
  const leaseToken = newLeaseToken();
  const result = await query(
    `UPDATE whatsapp_coexistence_history_jobs
     SET processing_status = 'processing',
         attempts = attempts + 1,
         claimed_at = NOW(),
         lease_token = $2,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND terminal_at IS NULL
       AND processing_status IN ('pending', 'failed')
     RETURNING *`,
    [safeId, leaseToken]
  );
  return result.rows[0] || null;
}

async function claimRecoverable(
  { limit = 10, staleAfterSeconds = 120, maxAttempts = 5 } = {},
  query = pool.query.bind(pool)
) {
  const leaseToken = newLeaseToken();
  const result = await query(
    `WITH candidates AS (
       SELECT id
       FROM whatsapp_coexistence_history_jobs
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
     UPDATE whatsapp_coexistence_history_jobs job
     SET processing_status = 'processing',
         attempts = job.attempts + 1,
         claimed_at = NOW(),
         lease_token = $4,
         last_error = NULL,
         updated_at = NOW()
     FROM candidates
     WHERE job.id = candidates.id
     RETURNING job.*`,
    [limit, staleAfterSeconds, maxAttempts, leaseToken]
  );
  return result.rows;
}

async function markCompleted(id, leaseToken, query = pool.query.bind(pool)) {
  if (!leaseToken) return null;
  const result = await query(
    `UPDATE whatsapp_coexistence_history_jobs
     SET processing_status = 'completed',
         completed_at = NOW(),
         claimed_at = NULL,
         lease_token = NULL,
         last_error = NULL,
         updated_at = NOW()
     WHERE id = $1
       AND lease_token = $2
       AND terminal_at IS NULL
       AND processing_status = 'processing'
     RETURNING *`,
    [id, leaseToken]
  );
  return result.rows[0] || null;
}

async function markFailed(id, leaseToken, error, query = pool.query.bind(pool)) {
  if (!leaseToken) return null;
  const message = String(error?.message || error || "History import failed.").slice(0, 1000);
  const result = await query(
    `UPDATE whatsapp_coexistence_history_jobs
     SET processing_status = 'failed',
         claimed_at = NULL,
         lease_token = NULL,
         last_error = $3,
         updated_at = NOW()
     WHERE id = $1
       AND lease_token = $2
       AND terminal_at IS NULL
       AND processing_status = 'processing'
     RETURNING *`,
    [id, leaseToken, message]
  );
  return result.rows[0] || null;
}

async function listExhausted(
  { limit = 10, staleAfterSeconds = 120, maxAttempts = 5 } = {},
  query = pool.query.bind(pool)
) {
  const result = await query(
    `SELECT *
     FROM whatsapp_coexistence_history_jobs
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

async function markTerminal(id, query = pool.query.bind(pool)) {
  const result = await query(
    `UPDATE whatsapp_coexistence_history_jobs
     SET processing_status = 'failed',
         claimed_at = NULL,
         lease_token = NULL,
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

async function pruneCompleted(
  { olderThanHours = 24 } = {},
  query = pool.query.bind(pool)
) {
  const result = await query(
    `DELETE FROM whatsapp_coexistence_history_jobs
     WHERE processing_status = 'completed'
       AND completed_at < NOW() - ($1::integer * interval '1 hour')`,
    [olderThanHours]
  );
  return result.rowCount || 0;
}

module.exports = {
  MAX_HISTORY_PAYLOAD_BYTES,
  eventKeyForHistory,
  serializePayload,
  store,
  claimById,
  claimRecoverable,
  markCompleted,
  markFailed,
  listExhausted,
  markTerminal,
  pruneCompleted,
};
