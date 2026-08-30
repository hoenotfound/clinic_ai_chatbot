const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");
const mediaStorage = require("../services/mediaStorageService");

const MAX_PORTAL_PAGE_SIZE = 100;

function clampPageSize(limit, fallback = 50) {
  const parsed = Number(limit);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, MAX_PORTAL_PAGE_SIZE);
}

// Every write path in this file still accepts a base64 string for media
// (same shape callers always used) but now uploads it to R2 and stores only
// the returned key in Postgres. Centralizing this here means server.js,
// conversationStore.js, and the routes never had to change.
async function persistMediaIfPresent(mediaBase64, mediaMimeType, contactId) {
  if (!mediaBase64) return null;
  const buffer = Buffer.from(mediaBase64, "base64");
  return mediaStorage.uploadMedia(buffer, mediaMimeType, { contactId });
}

// Mirrors persistMediaIfPresent's contract in reverse: resolves a stored key
// back into the {media_base64, media_mime_type} shape every caller already
// expects. Full buffering is intentionally reserved for callers that really
// need the bytes (AI image context and message retry), not browser playback.
async function resolveMediaBase64(mediaKey, mediaMimeType) {
  if (!mediaKey) return null;
  const buffer = await mediaStorage.downloadMedia(mediaKey);
  return { media_base64: buffer.toString("base64"), media_mime_type: mediaMimeType };
}

// Shared by the includeMedia=true paths in getMessagePageForContact (the
// getMessagesForContact one resolves inline since it always needs the full
// row shape). Renames media_key -> media_base64 in place to match what
// callers historically received.
async function resolveMediaKeysInRows(rows, includeMedia) {
  if (!includeMedia) return rows;
  for (const row of rows) {
    const key = row.media_key;
    delete row.media_key;
    row.media_base64 = key ? (await mediaStorage.downloadMedia(key)).toString("base64") : null;
  }
  return rows;
}

const LIGHTWEIGHT_MESSAGE_COLUMNS = `
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
  const mediaKey = await persistMediaIfPresent(mediaBase64, mediaMimeType, contactId);
  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     )
     INSERT INTO messages (contact_id, role, content, whatsapp_message_id, sent_by_username, media_url, media_key, media_mime_type)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8
     FROM conversation_lock
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [contactId, role, content, whatsappMessageId, sentByUsername, mediaUrl, mediaKey, mediaMimeType]
  );
  return result.rows[0];
}

/**
 * Atomically stores a newly received WhatsApp message. Meta can retry the same
 * webhook while an earlier request is still running, so a separate SELECT then
 * INSERT is not safe. The unique whatsapp_message_id constraint and
 * ON CONFLICT make exactly one request the owner of the message.
 */
async function saveInboundMessageIfNew(
  contactId,
  content,
  whatsappMessageId,
  mediaBase64 = null,
  mediaMimeType = null
) {
  const mediaKey = await persistMediaIfPresent(mediaBase64, mediaMimeType, contactId);
  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     )
     INSERT INTO messages (
       contact_id, role, content, whatsapp_message_id, media_key, media_mime_type
     )
     SELECT $1, 'user', $2, $3, $4, $5
     FROM conversation_lock
     ON CONFLICT (whatsapp_message_id) DO NOTHING
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [contactId, content, whatsappMessageId, mediaKey, mediaMimeType]
  );
  return result.rows[0] || null;
}

/** Updates the placeholder saved before media download/transcription finishes. */
async function updateInboundMessage(messageId, contactId, content, mediaBase64, mediaMimeType) {
  const mediaKey = await persistMediaIfPresent(mediaBase64, mediaMimeType, contactId);
  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $2::integer)
     )
     UPDATE messages
     SET content = $3, media_key = $4, media_mime_type = $5
     FROM conversation_lock
     WHERE id = $1 AND contact_id = $2 AND role = 'user'
     RETURNING ${LIGHTWEIGHT_MESSAGE_COLUMNS}`,
    [messageId, contactId, content, mediaKey, mediaMimeType]
  );
  return result.rows[0] || null;
}

/**
 * Recent history used internally by the AI. This stays array-based so the AI
 * path is independent from portal pagination.
 */
async function getMessagesForContact(contactId, limit = 50, includeMedia = true) {
  const safeLimit = clampPageSize(limit);
  const mediaColumn = includeMedia
    ? "media_key"
    : "(media_key IS NOT NULL) AS has_media_attachment";
  const result = await pool.query(
    `SELECT id, role, content, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type FROM messages
     WHERE contact_id = $1
       AND (
         role <> 'assistant'
         OR delivery_status IS NULL
         OR delivery_status NOT IN ('failed', 'unknown')
       )
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [contactId, safeLimit]
  );
  const rows = result.rows.reverse();
  if (!includeMedia) return rows;

  // Resolve each row's R2 key back into media_base64 so this keeps the same
  // shape callers already relied on (see getHistoryForContact/AI context).
  for (const row of rows) {
    const key = row.media_key;
    delete row.media_key;
    row.media_base64 = key ? (await mediaStorage.downloadMedia(key)).toString("base64") : null;
  }
  return rows;
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
    ? "media_key"
    : "(media_key IS NOT NULL) AS has_media_attachment";

  if (afterId != null) {
    const result = await pool.query(
      `SELECT id, role, content, whatsapp_message_id, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type,
              delivery_status, delivery_error, is_automated_follow_up
       FROM messages
       WHERE contact_id = $1 AND id > $2
       ORDER BY id ASC`,
      [contactId, afterId]
    );
    return { rows: await resolveMediaKeysInRows(result.rows, includeMedia), hasMore: false };
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
            delivery_status, delivery_error, is_automated_follow_up
     FROM messages
     WHERE contact_id = $1${cursorClause}
     ORDER BY id DESC
     LIMIT $${params.length}`,
    params
  );

  const hasMore = result.rows.length > safeLimit;
  const page = hasMore ? result.rows.slice(0, safeLimit) : result.rows;
  return { rows: await resolveMediaKeysInRows(page.reverse(), includeMedia), hasMore };
}

// Returns only the R2 reference and MIME metadata for one authenticated
// message lookup. The browser streaming route uses this instead of loading
// the whole object through Postgres/base64 before it can start responding.
async function getMessageMediaReferenceForContact(contactId, messageId) {
  const result = await pool.query(
    `SELECT media_key, media_mime_type
     FROM messages
     WHERE id = $1 AND contact_id = $2 AND media_key IS NOT NULL`,
    [messageId, contactId]
  );
  return result.rows[0] || null;
}

// Full-byte lookup used only where the application genuinely needs the entire
// attachment (for example the newest photo sent to the AI). Browser playback
// should use getMessageMediaReferenceForContact + R2 streaming instead.
async function getMessageMediaForContact(contactId, messageId) {
  const row = await getMessageMediaReferenceForContact(contactId, messageId);
  if (!row) return null;
  return resolveMediaBase64(row.media_key, row.media_mime_type);
}

// Retry needs the original stored attachment bytes. This is deliberately a
// single-message lookup and is only used by the authenticated retry route;
// normal Inbox payloads remain lightweight and never include base64 media.
async function getMessageForRetry(contactId, messageId) {
  const result = await pool.query(
    `SELECT id, contact_id, role, content, whatsapp_message_id, sent_by_username,
            media_url, media_key, media_mime_type, created_at,
            delivery_status, delivery_error, is_automated_follow_up
     FROM messages
     WHERE id = $1 AND contact_id = $2`,
    [messageId, contactId]
  );
  const row = result.rows[0];
  if (!row) return null;

  const key = row.media_key;
  delete row.media_key;
  row.media_base64 = key ? (await mediaStorage.downloadMedia(key)).toString("base64") : null;
  return row;
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
  saveInboundMessageIfNew,
  updateInboundMessage,
  getMessagesForContact,
  getMessagePageForContact,
  getMessageMediaReferenceForContact,
  getMessageMediaForContact,
  getMessageForRetry,
  getDeliveryStatusesForContact,
  acquireMessageRetryLock,
  setWhatsappMessageId,
  setDeliveryStatusById,
  updateDeliveryStatusByWamid,
};
