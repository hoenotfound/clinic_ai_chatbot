const db = require("./db");

/**
 * Finds a contact by WhatsApp number, creating one if it doesn't exist yet.
 * This is the natural entry point every inbound message goes through.
 */
function getOrCreateContact(whatsappNumber) {
  const existing = db
    .prepare("SELECT * FROM contacts WHERE whatsapp_number = ?")
    .get(whatsappNumber);
  if (existing) return existing;

  const result = db
    .prepare("INSERT INTO contacts (whatsapp_number) VALUES (?)")
    .run(whatsappNumber);

  return db.prepare("SELECT * FROM contacts WHERE id = ?").get(result.lastInsertRowid);
}

function getContactById(id) {
  return db.prepare("SELECT * FROM contacts WHERE id = ?").get(id);
}

function updateContactName(id, name) {
  db.prepare("UPDATE contacts SET name = ?, updated_at = datetime('now') WHERE id = ?").run(
    name,
    id
  );
}

/**
 * Lists every contact who has at least one message, with a preview of their
 * most recent message — this is what powers the Inbox list view.
 */
function listConversations() {
  return db
    .prepare(
      `
      SELECT
        c.id AS contact_id,
        c.whatsapp_number,
        c.name,
        m.content AS last_message,
        m.role AS last_message_role,
        m.created_at AS last_message_at
      FROM contacts c
      JOIN messages m ON m.id = (
        SELECT id FROM messages WHERE contact_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
      )
      ORDER BY m.created_at DESC
      `
    )
    .all();
}

module.exports = { getOrCreateContact, getContactById, updateContactName, listConversations };
