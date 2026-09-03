const { pool } = require("./db");

const SCHEDULED_MESSAGE_COLUMNS = `
  id,
  contact_id,
  content,
  scheduled_for,
  status,
  scheduled_by_username,
  created_at,
  updated_at,
  sent_at,
  cancelled_at,
  claimed_at,
  message_id,
  failure_reason
`;

async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id BIGSERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      scheduled_for TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled'
        CHECK (status IN ('scheduled', 'processing', 'sent', 'cancelled', 'failed', 'expired')),
      scheduled_by_username TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      message_id BIGINT REFERENCES messages(id) ON DELETE SET NULL,
      failure_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
      ON scheduled_messages (status, scheduled_for);
    CREATE INDEX IF NOT EXISTS idx_scheduled_messages_contact
      ON scheduled_messages (contact_id, status, scheduled_for);
  `);
}

async function getLatestInboundAt(contactId) {
  const result = await pool.query(
    `SELECT created_at
     FROM messages
     WHERE contact_id = $1 AND role = 'user'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [contactId]
  );
  return result.rows[0]?.created_at || null;
}

async function listForContact(contactId) {
  await ensureSchema();
  const result = await pool.query(
    `SELECT ${SCHEDULED_MESSAGE_COLUMNS}
     FROM scheduled_messages
     WHERE contact_id = $1
       AND status IN ('scheduled', 'processing', 'failed', 'expired')
     ORDER BY scheduled_for ASC, id ASC`,
    [contactId]
  );
  return result.rows;
}

async function create({ contactId, content, scheduledFor, username }) {
  await ensureSchema();
  const result = await pool.query(
    `INSERT INTO scheduled_messages (
       contact_id, content, scheduled_for, scheduled_by_username
     ) VALUES ($1, $2, $3, $4)
     RETURNING ${SCHEDULED_MESSAGE_COLUMNS}`,
    [contactId, content, scheduledFor, username || null]
  );
  return result.rows[0];
}

async function updateScheduled({ id, contactId, content, scheduledFor }) {
  await ensureSchema();
  const result = await pool.query(
    `UPDATE scheduled_messages
     SET content = $3,
         scheduled_for = $4,
         updated_at = NOW(),
         failure_reason = NULL
     WHERE id = $1 AND contact_id = $2 AND status = 'scheduled'
     RETURNING ${SCHEDULED_MESSAGE_COLUMNS}`,
    [id, contactId, content, scheduledFor]
  );
  return result.rows[0] || null;
}

async function cancel(id, contactId) {
  await ensureSchema();
  const result = await pool.query(
    `UPDATE scheduled_messages
     SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND contact_id = $2 AND status = 'scheduled'
     RETURNING ${SCHEDULED_MESSAGE_COLUMNS}`,
    [id, contactId]
  );
  return result.rows[0] || null;
}

async function claimDue(limit = 25) {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(
      `WITH due AS (
         SELECT id
         FROM scheduled_messages
         WHERE status = 'scheduled' AND scheduled_for <= NOW()
         ORDER BY scheduled_for ASC, id ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       UPDATE scheduled_messages s
       SET status = 'processing', claimed_at = NOW(), updated_at = NOW()
       FROM due
       WHERE s.id = due.id
       RETURNING s.${SCHEDULED_MESSAGE_COLUMNS.replace(/\n/g, " s.").replace(/^\s*s\./, "")}`,
      [limit]
    );
    await client.query("COMMIT");
    return result.rows;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function attachMessage(id, messageId) {
  const result = await pool.query(
    `UPDATE scheduled_messages
     SET message_id = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'processing'
     RETURNING ${SCHEDULED_MESSAGE_COLUMNS}`,
    [id, messageId]
  );
  return result.rows[0] || null;
}

async function markSent(id) {
  const result = await pool.query(
    `UPDATE scheduled_messages
     SET status = 'sent', sent_at = NOW(), updated_at = NOW(), failure_reason = NULL
     WHERE id = $1 AND status = 'processing'
     RETURNING ${SCHEDULED_MESSAGE_COLUMNS}`,
    [id]
  );
  return result.rows[0] || null;
}

async function markFailed(id, reason) {
  const result = await pool.query(
    `UPDATE scheduled_messages
     SET status = 'failed', failure_reason = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'processing'
     RETURNING ${SCHEDULED_MESSAGE_COLUMNS}`,
    [id, reason]
  );
  return result.rows[0] || null;
}

async function markExpired(id, reason) {
  const result = await pool.query(
    `UPDATE scheduled_messages
     SET status = 'expired', failure_reason = $2, updated_at = NOW()
     WHERE id = $1 AND status = 'processing'
     RETURNING ${SCHEDULED_MESSAGE_COLUMNS}`,
    [id, reason]
  );
  return result.rows[0] || null;
}

async function recoverStaleProcessing(olderThanMinutes = 10) {
  await ensureSchema();
  const result = await pool.query(
    `UPDATE scheduled_messages
     SET status = 'failed',
         failure_reason = 'Delivery became unconfirmed after the scheduler was interrupted. Review before retrying manually.',
         updated_at = NOW()
     WHERE status = 'processing'
       AND claimed_at < NOW() - ($1::text || ' minutes')::interval
     RETURNING ${SCHEDULED_MESSAGE_COLUMNS}`,
    [olderThanMinutes]
  );
  return result.rows;
}

module.exports = {
  ensureSchema,
  getLatestInboundAt,
  listForContact,
  create,
  updateScheduled,
  cancel,
  claimDue,
  attachMessage,
  markSent,
  markFailed,
  markExpired,
  recoverStaleProcessing,
};
