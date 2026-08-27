const { pool } = require("./db");

const MAX_PORTAL_PAGE_SIZE = 100;

function clampPageSize(limit, fallback = 50) {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_PORTAL_PAGE_SIZE);
}

const LIGHTWEIGHT_MESSAGE_COLUMNS = `
  id,
  contact_id,
  role,
  content,
  whatsapp_message_id,
  sent_by_username,
  media_url,
  (media_base64 IS NOT NULL) AS has_media_attachment,
  media_mime_type,
  created_at,
  delivery_status,
  delivery_error
`;

/**
 * Saves a message for a contact. Large media bytes are deliberately excluded
 * from RETURNING so an INSERT of a photo/voice note does not immediately send
 * the same base64 payload back out of Neon again.
 */
async function saveMessage(
  contactId,
  role,
  content,
  whatsappMessageId = null,
  sentByUsername = null,
  mediaUrl = null,
  mediaBase64 = null,
  mediaMimeType = null
) {
  const result = await pool.query(
    `INSERT INTO messages (contact_id, role, content, whatsapp_message_id, sent_by_username, media_url, media_base64, media_mime_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [contactId, role, content, whatsappMessageId, sentByUsername, mediaUrl, mediaBase64, mediaMimeType]
  );
  return result.rows[0];
}

/**
 * Recent history used internally by the AI. This stays array-based so the AI
 * path is independent from portal pagination.
 */
async function getMessagesForContact(contactId, limit = 50, includeMedia = true) {
  const safeLimit = clampPageSize(limit);
  const mediaColumn = includeMedia
    ? "media_base64"
    : "(media_base64 IS NOT NULL) AS has_media_attachment";
  const result = await pool.query(
    `SELECT id, role, content, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type FROM messages
     WHERE contact_id = $1
       AND (role <> 'assistant' OR delivery_status IS DISTINCT FROM 'failed')
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [contactId, safeLimit]
  );
  return result.rows.reverse();
}

/**
 * Lightweight portal page. Initial/before pages fetch one extra row so the
 * UI knows whether a "Load older messages" button is needed without a second
 * COUNT(*) query. afterId returns every unseen lightweight row so an SSE
 * reconnect can fully catch up even when more than 100 messages arrived while
 * the browser was disconnected.
 */
async function getMessagePageForContact(
  contactId,
  { limit = 50, beforeId = null, afterId = null, includeMedia = false } = {}
) {
  const safeLimit = clampPageSize(limit);
  const mediaColumn = includeMedia
    ? "media_base64"
    : "(media_base64 IS NOT NULL) AS has_media_attachment";

  if (afterId != null) {
    const result = await pool.query(
      `SELECT id, role, content, whatsapp_message_id, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type,
              delivery_status, delivery_error
       FROM messages
       WHERE contact_id = $1 AND id > $2
       ORDER BY id ASC`,
      [contactId, afterId]
    );
    return { rows: result.rows, hasMore: false };
  }

  const params = [contactId];
  let cursorClause = "";
  if (beforeId != null) {
    params.push(beforeId);
    cursorClause = ` AND id < $${params.length}`;
  }
  params.push(safeLimit + 1);

  const result = await pool.query(
    `SELECT id, role, content, whatsapp_message_id, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type,
            delivery_status, delivery_error
     FROM messages
     WHERE contact_id = $1${cursorClause}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params
  );

  const hasMore = result.rows.length > safeLimit;
  const page = hasMore ? result.rows.slice(0, safeLimit) : result.rows;
  return { rows: page.reverse(), hasMore };
}

// Fetches one stored attachment only when the browser actually needs to
// display or play it. Keeping these bytes out of polling responses avoids
// repeatedly transferring every photo and recording.
async function getMessageMediaForContact(contactId, messageId) {
  const result = await pool.query(
    `SELECT media_base64, media_mime_type
     FROM messages
     WHERE id = $1 AND contact_id = $2 AND media_base64 IS NOT NULL`,
    [messageId, contactId]
  );
  return result.rows[0] || null;
}

// Retry needs the original stored attachment bytes. This is deliberately a
// single-message lookup and is only used by the authenticated retry route;
// normal Inbox payloads remain lightweight and never include base64 media.
async function getMessageForRetry(contactId, messageId) {
  const result = await pool.query(
    `SELECT id, contact_id, role, content, whatsapp_message_id, sent_by_username,
            media_url, media_base64, media_mime_type, created_at,
            delivery_status, delivery_error
     FROM messages
     WHERE id = $1 AND contact_id = $2`,
    [messageId, contactId]
  );
  return result.rows[0] || null;
}

// Resyncs the delivery state for messages that are already visible in an
// Inbox thread after its SSE connection reconnects. Restricting by contact id
// prevents message ids from another conversation being exposed accidentally.
async function getDeliveryStatusesForContact(contactId, messageIds) {
  if (!messageIds.length) return [];
  const result = await pool.query(
    `SELECT id, whatsapp_message_id, delivery_status, delivery_error
     FROM messages
     WHERE contact_id = $1 AND id = ANY($2::int[])`,
    [contactId, messageIds]
  );
  return result.rows;
}

// Uses a transaction-scoped Postgres lock so the same failed message cannot be
// retried concurrently by different server instances. Keeping the transaction
// on one checked-out connection also works when Neon is using a connection
// pooler, and a dropped server process releases the lock automatically.
async function acquireMessageRetryLock(messageId) {
  const client = await pool.connect();
  let transactionStarted = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    const result = await client.query(
      "SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired",
      [messageId]
    );
    if (!result.rows[0]?.acquired) {
      await client.query("ROLLBACK");
      client.release();
      return null;
    }

    let released = false;
    return async function releaseMessageRetryLock() {
      if (released) return;
      released = true;

      try {
        await client.query("COMMIT");
        client.release();
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        client.release(true);
        throw err;
      }
    };
  } catch (err) {
    if (transactionStarted) {
      await client.query("ROLLBACK").catch(() => {});
    }
    client.release(true);
    throw err;
  }
}

async function messageExistsByWhatsappId(whatsappMessageId) {
  if (!whatsappMessageId) return false;
  const result = await pool.query(
    "SELECT 1 FROM messages WHERE whatsapp_message_id = $1",
    [whatsappMessageId]
  );
  return result.rows.length > 0;
}

/**
 * Attach Meta's WAMID and mark the request as pending. "pending" means Meta
 * accepted the request, while sent/delivered/read still come from webhooks.
 */
async function setWhatsappMessageId(messageId, whatsappMessageId) {
  if (!whatsappMessageId) return null;
  const result = await pool.query(
    `UPDATE messages
     SET whatsapp_message_id = $2, delivery_status = 'pending', delivery_error = NULL
     WHERE id = $1
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [messageId, whatsappMessageId]
  );
  return result.rows[0] || null;
}

// Records an outcome for a send attempt that produced no new WAMID. Clearing
// the previous WAMID keeps a delayed webhook from an older attempt from being
// applied to the current failure.
async function setDeliveryStatusById(messageId, status, errorText = null) {
  const result = await pool.query(
    `UPDATE messages
     SET whatsapp_message_id = NULL, delivery_status = $2, delivery_error = $3
     WHERE id = $1
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [messageId, status, errorText]
  );
  return result.rows[0] || null;
}

/**
 * Delivery webhooks only need the contact id (for failures) plus status data.
 * Never return media_base64 here. Repeated identical webhook statuses are also
 * ignored so they do not create needless writes.
 */
async function updateDeliveryStatusByWamid(whatsappMessageId, status, errorText = null) {
  const result = await pool.query(
    `UPDATE messages SET delivery_status = $2, delivery_error = $3
     WHERE whatsapp_message_id = $1
       AND (delivery_status IS DISTINCT FROM $2 OR delivery_error IS DISTINCT FROM $3)
       AND (
         $2 = 'failed'
         OR delivery_status IS NULL
         OR CASE $2
              WHEN 'sent' THEN 1
              WHEN 'delivered' THEN 2
              WHEN 'read' THEN 3
              ELSE 0
            END >= CASE delivery_status
              WHEN 'pending' THEN 0
              WHEN 'sent' THEN 1
              WHEN 'delivered' THEN 2
              WHEN 'read' THEN 3
              WHEN 'failed' THEN 4
              ELSE -1
            END
       )
     RETURNING id, contact_id, whatsapp_message_id, delivery_status, delivery_error`,
    [whatsappMessageId, status, errorText]
  );
  return result.rows[0] || null;
}

module.exports = {
  saveMessage,
  getMessagesForContact,
  getMessagePageForContact,
  getMessageMediaForContact,
  getMessageForRetry,
  getDeliveryStatusesForContact,
  acquireMessageRetryLock,
  messageExistsByWhatsappId,
  setWhatsappMessageId,
  setDeliveryStatusById,
  updateDeliveryStatusByWamid,
};
