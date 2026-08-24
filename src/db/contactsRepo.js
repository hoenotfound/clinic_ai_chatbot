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
      c.mode,
      c.takeover_by,
      c.takeover_at,
      c.needs_attention,
      c.attention_reason,
      m.content AS last_message,
      m.role AS last_message_role,
      m.media_url AS last_message_media_url,
      m.created_at AS last_message_at
    FROM contacts c
    JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE contact_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
    )
    ORDER BY c.needs_attention DESC, m.created_at DESC
    `
  );
  return result.rows;
}

/**
 * Switches a conversation to staff-owned mode: the AI stops auto-replying
 * until someone calls setModeToAi. Also clears the attention flag, since a
 * human now explicitly owns this conversation.
 */
async function takeOver(id, staffUsername) {
  const result = await pool.query(
    `UPDATE contacts
     SET mode = 'human', takeover_by = $1, takeover_at = now(),
         needs_attention = false, attention_reason = NULL, updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [staffUsername, id]
  );
  return result.rows[0] || null;
}

/**
 * Hands the conversation back to the AI. Does not touch needs_attention —
 * if something is still flagged, it should stay flagged.
 */
async function returnToAi(id) {
  const result = await pool.query(
    `UPDATE contacts
     SET mode = 'ai', takeover_by = NULL, takeover_at = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

/**
 * Flags or clears the "needs a human" indicator. reason is a short string
 * shown in the portal (e.g. "AI handed off", "Patient asked for a human").
 * Passing needsAttention=false clears the reason too.
 */
async function setAttention(id, needsAttention, reason = null) {
  const result = await pool.query(
    `UPDATE contacts
     SET needs_attention = $1, attention_reason = $2, updated_at = now()
     WHERE id = $3
     RETURNING *`,
    [needsAttention, needsAttention ? reason : null, id]
  );
  return result.rows[0] || null;
}

module.exports = {
  getOrCreateContact,
  getContactById,
  updateContactName,
  listConversations,
  takeOver,
  returnToAi,
  setAttention,
};
