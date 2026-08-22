const { pool } = require("./db");

/**
 * Finds a contact by WhatsApp number, creating one if it doesn't exist yet.
 * This is the natural entry point every inbound message goes through.
 */
async function getOrCreateContact(whatsappNumber) {
  const existing = await pool.query(
    "SELECT * FROM contacts WHERE whatsapp_number = $1",
    [whatsappNumber]
  );
  if (existing.rows[0]) return existing.rows[0];

  const inserted = await pool.query(
    "INSERT INTO contacts (whatsapp_number) VALUES ($1) RETURNING *",
    [whatsappNumber]
  );
  return inserted.rows[0];
}

async function getContactById(id) {
  const result = await pool.query("SELECT * FROM contacts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function updateContactName(id, name) {
  await pool.query(
    "UPDATE contacts SET name = $1, updated_at = now() WHERE id = $2",
    [name, id]
  );
}

/**
 * Lists every contact who has at least one message, with a preview of their
 * most recent message — this is what powers the Inbox list view.
 */
async function listConversations() {
  const result = await pool.query(
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
  );
  return result.rows;
}

module.exports = { getOrCreateContact, getContactById, updateContactName, listConversations };
