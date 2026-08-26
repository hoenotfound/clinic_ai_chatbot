const { pool } = require("./db");

// Matches the format WhatsApp's Cloud API sends as `message.from` — digits
// only, country code included, no leading "+" (see
// services/whatsappService.js parseIncomingMessages). Manually-added
// contacts are normalized to the same shape so that if the patient later
// messages in for real, getOrCreateContact() matches the existing row
// instead of creating a duplicate.
function normalizeWhatsappNumber(input) {
  return String(input || "").replace(/[^\d]/g, "");
}

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
 * Full patient directory for the Contacts page — every contact (not just
 * ones with messages, unlike listConversations below, since a contact can
 * now be added manually before they've ever messaged in). `search` filters
 * by name or WhatsApp number, case-insensitive, matched anywhere in either.
 */
async function listContacts(search) {
  const term = (search || "").trim();
  const params = term ? [`%${term}%`] : [];
  const result = await pool.query(
    `
    SELECT
      c.id, c.whatsapp_number, c.name, c.mode, c.needs_attention, c.created_at, c.updated_at,
      c.channel, c.photo_url,
      COUNT(m.id)::int AS message_count,
      MAX(m.created_at) AS last_message_at
    FROM contacts c
    LEFT JOIN messages m ON m.contact_id = c.id
    ${term ? "WHERE c.name ILIKE $1 OR c.whatsapp_number ILIKE $1" : ""}
    GROUP BY c.id
    ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC
    `,
    params
  );
  return result.rows;
}

/**
 * Manually adds a contact from the Contacts page (staff entering a patient
 * who hasn't messaged in yet). Throws with `.code === "23505"` on a
 * duplicate WhatsApp number — see routes/contacts.js for how that's turned
 * into a friendly error.
 */
async function createContact({ name, whatsappNumber }) {
  const result = await pool.query(
    "INSERT INTO contacts (name, whatsapp_number) VALUES ($1, $2) RETURNING *",
    [name || null, normalizeWhatsappNumber(whatsappNumber)]
  );
  return result.rows[0];
}

/**
 * Edits a contact's name and/or WhatsApp number from the Contacts page.
 * Same duplicate-number error shape as createContact.
 */
async function updateContact(id, { name, whatsappNumber }) {
  const result = await pool.query(
    "UPDATE contacts SET name = $1, whatsapp_number = $2, updated_at = now() WHERE id = $3 RETURNING *",
    [name || null, normalizeWhatsappNumber(whatsappNumber), id]
  );
  return result.rows[0] || null;
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
      c.channel,
      c.photo_url,
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
  listContacts,
  createContact,
  updateContact,
  normalizeWhatsappNumber,
  takeOver,
  returnToAi,
  setAttention,
};
