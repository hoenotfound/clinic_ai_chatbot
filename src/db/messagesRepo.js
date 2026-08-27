const { pool } = require("./db");

/**
 * Saves a message for a contact. whatsappMessageId is only present for
 * inbound patient messages (used for dedup); outbound AI replies pass null.
 * sentByUsername is only set for outbound messages a staff member typed
 * themselves from the portal — leave null for AI-generated replies.
 * mediaUrl is only set for image messages *we* send by public link (e.g.
 * the promo graphic) — leave null otherwise.
 * mediaBase64/mediaMimeType are only set for photos a *patient* sends us —
 * WhatsApp only gives us a short-lived download link for inbound media, so
 * we persist the actual bytes instead, both so the Inbox can render the
 * photo and so the AI can still look at it in later turns of the conversation.
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
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [contactId, role, content, whatsappMessageId, sentByUsername, mediaUrl, mediaBase64, mediaMimeType]
  );
  return result.rows[0];
}

/**
 * Full message history for one contact, oldest first — used both for
 * rendering the Inbox thread and for giving the AI conversation context.
 */
async function getMessagesForContact(contactId, limit = 50, includeMedia = true) {
  const mediaColumn = includeMedia
    ? "media_base64"
    : "(media_base64 IS NOT NULL) AS has_media_attachment";
  const result = await pool.query(
    `SELECT id, role, content, created_at, sent_by_username, media_url, ${mediaColumn}, media_mime_type FROM messages
     WHERE contact_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [contactId, limit]
  );
  return result.rows.reverse(); // back to chronological order
}

// Fetches one stored attachment only when the browser actually needs to
// display or play it. Keeping these bytes out of the Inbox's five-second
// polling response avoids repeatedly transferring every photo and recording.
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

/**
 * Attaches Meta's WAMID to a staff-sent message row after the fact. Staff
 * routes (see routes/conversations.js) save the message to the DB *before*
 * calling WhatsApp's send API, so the WAMID Meta returns isn't known yet at
 * saveMessage() time. Calling this right after a successful send is what
 * lets a later delivery-status webhook (see updateDeliveryStatusByWamid)
 * find its way back to this specific row.
 */
async function setWhatsappMessageId(messageId, whatsappMessageId) {
  if (!whatsappMessageId) return null;
  const result = await pool.query(
    `UPDATE messages SET whatsapp_message_id = $2 WHERE id = $1 RETURNING *`,
    [messageId, whatsappMessageId]
  );
  return result.rows[0] || null;
}

/**
 * Records the outcome of an async delivery-status webhook callback (see
 * server.js POST /webhook, whatsappService.parseStatusUpdates). Returns the
 * updated row (including contact_id) so the caller can flag the contact for
 * attention on a 'failed' status, or null if no message with that WAMID is
 * on file (e.g. it predates whatsapp_message_id being captured for outbound
 * messages, or the status is for an inbound message we don't track status for).
 */
async function updateDeliveryStatusByWamid(whatsappMessageId, status, errorText = null) {
  const result = await pool.query(
    `UPDATE messages SET delivery_status = $2, delivery_error = $3
     WHERE whatsapp_message_id = $1
     RETURNING *`,
    [whatsappMessageId, status, errorText]
  );
  return result.rows[0] || null;
}

module.exports = {
  saveMessage,
  getMessagesForContact,
  getMessageMediaForContact,
  messageExistsByWhatsappId,
  setWhatsappMessageId,
  updateDeliveryStatusByWamid,
};
