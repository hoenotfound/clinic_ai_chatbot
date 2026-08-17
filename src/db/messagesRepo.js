const db = require("./db");

/**
 * Saves a message for a contact. whatsappMessageId is only present for
 * inbound patient messages (used for dedup); outbound AI replies pass null.
 */
function saveMessage(contactId, role, content, whatsappMessageId = null) {
  db.prepare(
    `INSERT INTO messages (contact_id, role, content, whatsapp_message_id) VALUES (?, ?, ?, ?)`
  ).run(contactId, role, content, whatsappMessageId);
}

/**
 * Full message history for one contact, oldest first — used both for
 * rendering the Inbox thread and for giving the AI conversation context.
 */
function getMessagesForContact(contactId, limit = 50) {
  const rows = db
    .prepare(
      `SELECT role, content, created_at FROM messages
       WHERE contact_id = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(contactId, limit);
  return rows.reverse(); // back to chronological order
}

function messageExistsByWhatsappId(whatsappMessageId) {
  if (!whatsappMessageId) return false;
  const row = db
    .prepare("SELECT 1 FROM messages WHERE whatsapp_message_id = ?")
    .get(whatsappMessageId);
  return !!row;
}

module.exports = { saveMessage, getMessagesForContact, messageExistsByWhatsappId };
