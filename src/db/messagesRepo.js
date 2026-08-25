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
async function getMessagesForContact(contactId, limit = 50) {
  const result = await pool.query(
    `SELECT role, content, created_at, sent_by_username, media_url, media_base64, media_mime_type FROM messages
     WHERE contact_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [contactId, limit]
  );
  return result.rows.reverse(); // back to chronological order
}

async function messageExistsByWhatsappId(whatsappMessageId) {
  if (!whatsappMessageId) return false;
  const result = await pool.query(
    "SELECT 1 FROM messages WHERE whatsapp_message_id = $1",
    [whatsappMessageId]
  );
  return result.rows.length > 0;
}

module.exports = { saveMessage, getMessagesForContact, messageExistsByWhatsappId };
