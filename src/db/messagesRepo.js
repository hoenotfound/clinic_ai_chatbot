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
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [contactId, safeLimit]
  );
  return result.rows.reverse();
}

/**
 * Lightweight portal page. Initial/before pages fetch one extra row so the
 * UI knows whether a "Load older messages" button is needed without a second
 * COUNT(*) query. afterId is used for tiny incremental refreshes.
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
      `SELECT id, role, content, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type,
              delivery_status, delivery_error
       FROM messages
       WHERE contact_id = $1 AND id > $2
       ORDER BY id ASC
       LIMIT $3`,
      [contactId, afterId, safeLimit]
    );
    return { rows: result.rows, hasMore: result.rows.length === safeLimit };
  }

  const params = [contactId];
  let cursorClause = "";
  if (beforeId != null) {
    params.push(beforeId);
    cursorClause = ` AND id < $${params.length}`;
  }
  params.push(safeLimit + 1);

  const result = await pool.query(
    `SELECT id, role, content, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type,
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

async function messageExistsByWhatsappId(whatsappMessageId) {
  if (!whatsappMessageId) return false;
  const result = await pool.query(
    "SELECT 1 FROM messages WHERE whatsapp_message_id = $1",
    [whatsappMessageId]
  );
  return result.rows.length > 0;
}

/** Attach Meta's WAMID without returning a potentially multi-megabyte row. */
async function setWhatsappMessageId(messageId, whatsappMessageId) {
  if (!whatsappMessageId) return null;
  const result = await pool.query(
    `UPDATE messages SET whatsapp_message_id = $2 WHERE id = $1 RETURNING id`,
    [messageId, whatsappMessageId]
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
     RETURNING id, contact_id, delivery_status, delivery_error`,
    [whatsappMessageId, status, errorText]
  );
  return result.rows[0] || null;
}

module.exports = {
  saveMessage,
  getMessagesForContact,
  getMessagePageForContact,
  getMessageMediaForContact,
  messageExistsByWhatsappId,
  setWhatsappMessageId,
  updateDeliveryStatusByWamid,
};
