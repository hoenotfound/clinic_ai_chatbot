const crypto = require("crypto");
const { pool } = require("./db");

const HUMAN_ALERT_LOCK_NAMESPACE = 24682;
const IMMEDIATE_ALERT_MAX_ATTEMPTS = 5;
const IMMEDIATE_ALERT_STALE_AFTER_SECONDS = 60;
const IMMEDIATE_ALERT_BATCH_SIZE = 20;

function newLeaseToken() {
  return crypto.randomBytes(16).toString("hex");
}

function cleanText(value) {
  return String(value || "").trim();
}

async function insertAlert(
  {
    eventKey,
    type,
    contactId,
    messageText,
  },
  query
) {
  const key = cleanText(eventKey);
  const alertType = cleanText(type);
  const text = cleanText(messageText);
  const numericContactId = Number(contactId);

  if (!key || !alertType || !text) {
    throw new Error("Immediate Telegram alerts require eventKey, type, and messageText.");
  }
  if (!Number.isSafeInteger(numericContactId) || numericContactId < 1) {
    throw new Error("Immediate Telegram alerts require a valid contactId.");
  }

  const result = await query(
    `INSERT INTO telegram_immediate_alerts (
       event_key,
       alert_type,
       contact_id,
       message_text,
       status,
       attempts,
       next_attempt_at,
       updated_at
     )
     VALUES ($1, $2, $3, $4, 'pending', 0, now(), now())
     ON CONFLICT (event_key) DO NOTHING
     RETURNING *`,
    [key, alertType, numericContactId, text]
  );
  return result.rows[0] || null;
}

async function queueAlert(
  {
    eventKey,
    type,
    contactId,
    messageText,
    cooldownMinutes = 0,
  },
  database = pool
) {
  const safeCooldown = Math.max(0, Number(cooldownMinutes) || 0);

  if (type !== "human_intervention" || safeCooldown <= 0) {
    return insertAlert(
      { eventKey, type, contactId, messageText },
      database.query.bind(database)
    );
  }

  const client = await database.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
      [HUMAN_ALERT_LOCK_NAMESPACE, Number(contactId)]
    );

    const recent = await client.query(
      `SELECT id
       FROM telegram_immediate_alerts
       WHERE contact_id = $1
         AND alert_type = 'human_intervention'
         AND created_at > now() - ($2::integer * interval '1 minute')
       ORDER BY created_at DESC
       LIMIT 1`,
      [Number(contactId), Math.ceil(safeCooldown)]
    );

    if (recent.rows[0]) {
      await client.query("COMMIT");
      return null;
    }

    const queued = await insertAlert(
      { eventKey, type, contactId, messageText },
      client.query.bind(client)
    );
    await client.query("COMMIT");
    return queued;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function claimReady(
  {
    limit = IMMEDIATE_ALERT_BATCH_SIZE,
    staleAfterSeconds = IMMEDIATE_ALERT_STALE_AFTER_SECONDS,
    maxAttempts = IMMEDIATE_ALERT_MAX_ATTEMPTS,
  } = {},
  query = pool.query.bind(pool)
) {
  const leaseToken = newLeaseToken();
  const result = await query(
    `WITH candidates AS (
       SELECT id
       FROM telegram_immediate_alerts
       WHERE terminal_at IS NULL
         AND attempts < $3
         AND (
           (
             status = 'pending'
             AND COALESCE(next_attempt_at, created_at) <= now()
           )
           OR (
             status = 'sending'
             AND claimed_at <= now() - ($2::integer * interval '1 second')
           )
         )
       ORDER BY COALESCE(next_attempt_at, created_at), id
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE telegram_immediate_alerts alert
     SET status = 'sending',
         attempts = alert.attempts + 1,
         claimed_at = now(),
         lease_token = $4,
         next_attempt_at = NULL,
         error_text = NULL,
         updated_at = now()
     FROM candidates
     WHERE alert.id = candidates.id
     RETURNING alert.*`,
    [limit, staleAfterSeconds, maxAttempts, leaseToken]
  );
  return result.rows;
}

async function markSent(id, leaseToken, query = pool.query.bind(pool)) {
  if (!leaseToken) return null;
  const result = await query(
    `UPDATE telegram_immediate_alerts
     SET status = 'sent',
         sent_at = now(),
         claimed_at = NULL,
         lease_token = NULL,
         next_attempt_at = NULL,
         error_text = NULL,
         updated_at = now()
     WHERE id = $1
       AND lease_token = $2
       AND status = 'sending'
       AND terminal_at IS NULL
     RETURNING *`,
    [id, leaseToken]
  );
  return result.rows[0] || null;
}

async function markFailed(
  id,
  leaseToken,
  error,
  {
    retryDelaySeconds = 60,
    maxAttempts = IMMEDIATE_ALERT_MAX_ATTEMPTS,
  } = {},
  query = pool.query.bind(pool)
) {
  if (!leaseToken) return null;
  const message = String(error?.message || error || "Telegram send failed.").slice(0, 1000);
  const delay = Math.max(1, Math.ceil(Number(retryDelaySeconds) || 60));

  const result = await query(
    `UPDATE telegram_immediate_alerts
     SET status = CASE WHEN attempts >= $4 THEN 'failed' ELSE 'pending' END,
         terminal_at = CASE WHEN attempts >= $4 THEN now() ELSE NULL END,
         next_attempt_at = CASE
           WHEN attempts >= $4 THEN NULL
           ELSE now() + ($3::integer * interval '1 second')
         END,
         claimed_at = NULL,
         lease_token = NULL,
         error_text = $5,
         updated_at = now()
     WHERE id = $1
       AND lease_token = $2
       AND status = 'sending'
       AND terminal_at IS NULL
     RETURNING *`,
    [id, leaseToken, delay, maxAttempts, message]
  );
  return result.rows[0] || null;
}

async function markExhaustedStale(
  {
    staleAfterSeconds = IMMEDIATE_ALERT_STALE_AFTER_SECONDS,
    maxAttempts = IMMEDIATE_ALERT_MAX_ATTEMPTS,
  } = {},
  query = pool.query.bind(pool)
) {
  const result = await query(
    `UPDATE telegram_immediate_alerts
     SET status = 'failed',
         terminal_at = COALESCE(terminal_at, now()),
         claimed_at = NULL,
         lease_token = NULL,
         next_attempt_at = NULL,
         error_text = COALESCE(error_text, 'Telegram alert worker stopped during the final send attempt.'),
         updated_at = now()
     WHERE terminal_at IS NULL
       AND status = 'sending'
       AND attempts >= $2
       AND claimed_at <= now() - ($1::integer * interval '1 second')
     RETURNING id`,
    [staleAfterSeconds, maxAttempts]
  );
  return result.rows;
}

async function findNextDueAt(
  {
    staleAfterSeconds = IMMEDIATE_ALERT_STALE_AFTER_SECONDS,
    maxAttempts = IMMEDIATE_ALERT_MAX_ATTEMPTS,
  } = {},
  query = pool.query.bind(pool)
) {
  const result = await query(
    `SELECT MIN(
       CASE
         WHEN status = 'pending' AND attempts < $2
           THEN COALESCE(next_attempt_at, created_at)
         WHEN status = 'sending'
           THEN claimed_at + ($1::integer * interval '1 second')
         ELSE NULL
       END
     ) AS due_at
     FROM telegram_immediate_alerts
     WHERE terminal_at IS NULL
       AND status IN ('pending', 'sending')
       AND (
         attempts < $2
         OR status = 'sending'
       )`,
    [staleAfterSeconds, maxAttempts]
  );
  return result.rows[0]?.due_at || null;
}

module.exports = {
  HUMAN_ALERT_LOCK_NAMESPACE,
  IMMEDIATE_ALERT_BATCH_SIZE,
  IMMEDIATE_ALERT_MAX_ATTEMPTS,
  IMMEDIATE_ALERT_STALE_AFTER_SECONDS,
  claimReady,
  findNextDueAt,
  insertAlert,
  markExhaustedStale,
  markFailed,
  markSent,
  queueAlert,
};
