const { pool } = require("./db");

/**
 * Saves a message for a contact. whatsappMessageId is only present for
 * inbound patient messages (used for dedup); outbound AI replies pass null.
 */
async function saveMessage(contactId, role, content, whatsappMessageId = null) {
  await pool.query(
    `INSERT INTO messages (contact_id, role, content, whatsapp_message_id) VALUES ($1, $2, $3, $4)`,
    [contactId, role, content, whatsappMessageId]
  );
}

/**
 * Full message history for one contact, oldest first — used both for
 * rendering the Inbox thread and for giving the AI conversation context.
 */
async function getMessagesForContact(contactId, limit = 50) {
  const result = await pool.query(
    `SELECT role, content, created_at FROM messages
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
