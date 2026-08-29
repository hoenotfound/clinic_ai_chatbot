const { pool } = require("./db");
const realtimeEvents = require("../utils/realtimeEvents");
const telegramImmediateAlerts = require("../services/telegramImmediateAlertService");

function normalizeWhatsappNumber(input) {
  return String(input || "").replace(/[^\d]/g, "");
}

function publishContactChange(id) {
  if (!id) return;
  realtimeEvents.publish("conversation_changed", {
    contactId: id,
    reason: "contact_state",
  });
}

function notifyTelegram(promise, label, contactId) {
  Promise.resolve(promise).catch((err) => {
    console.error(`Telegram ${label} alert failed for contact ${contactId}:`, err);
  });
}

async function getOrCreateContact(whatsappNumber, whatsappProfileName = null) {
  const profileName = whatsappProfileName?.trim() || null;
  const inserted = await pool.query(
    `INSERT INTO contacts (whatsapp_number, whatsapp_profile_name)
     VALUES ($1, $2)
     ON CONFLICT (whatsapp_number) DO NOTHING
     RETURNING *`,
    [whatsappNumber, profileName]
  );
  if (inserted.rows[0]) return inserted.rows[0];

  if (profileName) {
    const updated = await pool.query(
      `UPDATE contacts
       SET whatsapp_profile_name = $2, updated_at = now()
       WHERE whatsapp_number = $1
         AND whatsapp_profile_name IS DISTINCT FROM $2
       RETURNING *`,
      [whatsappNumber, profileName]
    );
    if (updated.rows[0]) return updated.rows[0];
  }

  const existing = await pool.query(
    "SELECT * FROM contacts WHERE whatsapp_number = $1",
    [whatsappNumber]
  );
  return existing.rows[0];
}

async function getContactById(id) {
  const result = await pool.query("SELECT * FROM contacts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

async function updateContactName(id, name) {
  const result = await pool.query(
    "UPDATE contacts SET name = $1, updated_at = now() WHERE id = $2 RETURNING id",
    [name, id]
  );
  if (result.rows[0]) publishContactChange(result.rows[0].id);
}

async function listContacts(search) {
  const term = (search || "").trim();
  const params = term ? [`%${term}%`] : [];
  const result = await pool.query(
    `
    SELECT
      c.id, c.whatsapp_number, c.name, c.whatsapp_profile_name, c.mode, c.needs_attention,
      c.is_unread, c.needs_follow_up, c.created_at, c.updated_at,
      c.channel, c.photo_url,
      COUNT(m.id)::int AS message_count,
      MAX(m.created_at) AS last_message_at
    FROM contacts c
    LEFT JOIN messages m ON m.contact_id = c.id
    ${term ? "WHERE c.name ILIKE $1 OR c.whatsapp_profile_name ILIKE $1 OR c.whatsapp_number ILIKE $1" : ""}
    GROUP BY c.id
    ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC
    `,
    params
  );
  return result.rows;
}

async function createContact({ name, whatsappNumber }) {
  const result = await pool.query(
    "INSERT INTO contacts (name, whatsapp_number) VALUES ($1, $2) RETURNING *",
    [name || null, normalizeWhatsappNumber(whatsappNumber)]
  );
  return result.rows[0];
}

async function updateContact(id, { name, whatsappNumber }) {
  const result = await pool.query(
    "UPDATE contacts SET name = $1, whatsapp_number = $2, updated_at = now() WHERE id = $3 RETURNING *",
    [name || null, normalizeWhatsappNumber(whatsappNumber), id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function listConversations() {
  const result = await pool.query(
    `
    SELECT
      c.id AS contact_id,
      c.whatsapp_number,
      c.name,
      c.whatsapp_profile_name,
      c.channel,
      c.photo_url,
      c.mode,
      c.takeover_by,
      c.takeover_at,
      c.needs_attention,
      c.attention_reason,
      c.is_unread,
      c.needs_follow_up,
      m.content AS last_message,
      m.role AS last_message_role,
      m.media_url AS last_message_media_url,
      m.created_at AS last_message_at,
      EXISTS (
        SELECT 1
        FROM messages inbound
        WHERE inbound.contact_id = c.id
          AND inbound.role = 'user'
          AND NOT EXISTS (
            SELECT 1
            FROM messages outbound
            WHERE outbound.contact_id = c.id
              AND outbound.role = 'assistant'
              AND (
                outbound.delivery_status IS NULL
                OR outbound.delivery_status NOT IN ('failed', 'unknown')
              )
              AND (outbound.created_at, outbound.id) > (inbound.created_at, inbound.id)
          )
      ) AS has_unreplied
    FROM contacts c
    JOIN messages m ON m.id = (
      SELECT id FROM messages WHERE contact_id = c.id ORDER BY created_at DESC, id DESC LIMIT 1
    )
    ORDER BY c.needs_attention DESC, m.created_at DESC
    `
  );
  return result.rows;
}

async function takeOver(id, staffUsername) {
  const result = await pool.query(
    `UPDATE contacts
     SET mode = 'human', takeover_by = $1, takeover_at = now(),
         needs_attention = false, attention_reason = NULL, is_unread = false,
         updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [staffUsername, id]
  );
  const updated = result.rows[0] || null;
  // Keep the existing Telegram cooldown while staff owns the chat. Otherwise
  // the very next customer message in human mode could immediately generate a
  // second intervention alert for the same unresolved conversation.
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function returnToAi(id) {
  const result = await pool.query(
    `UPDATE contacts
     SET mode = 'ai', takeover_by = NULL, takeover_at = NULL, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [id]
  );
  const updated = result.rows[0] || null;
  // Human-intervention Telegram alerts use a strict rolling 30-minute
  // per-contact cooldown. Returning to AI must not reopen that window early.
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function setAttention(id, needsAttention, reason = null) {
  const result = await pool.query(
    `UPDATE contacts c
     SET needs_attention = $1, attention_reason = $2, updated_at = now()
     WHERE c.id = $3
     RETURNING c.*,
       (SELECT m.id FROM messages m
        WHERE m.contact_id = c.id AND m.role = 'user'
        ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS attention_message_id`,
    [needsAttention, needsAttention ? reason : null, id]
  );
  const updated = result.rows[0] || null;
  if (updated) {
    // Clearing an Inbox attention flag is operational state only. It must not
    // reset the Telegram anti-spam window for this contact.
    publishContactChange(updated.id);
    if (needsAttention) {
      notifyTelegram(
        telegramImmediateAlerts.sendHumanInterventionAlert({
          contactId: updated.id,
          messageId: updated.attention_message_id,
          reason: updated.attention_reason || reason || "Human review requested.",
        }),
        "human intervention",
        updated.id
      );
    }
  }
  return updated;
}

// Delivery problems should not replace a more important reason that already
// needs staff attention, such as an urgent keyword or an AI handoff. Repeated
// delivery failures may update the existing delivery reason with newer detail.
async function setDeliveryAttention(id, reason) {
  const result = await pool.query(
    `UPDATE contacts
     SET needs_attention = true, attention_reason = $1, updated_at = now()
     WHERE id = $2
       AND (
         needs_attention = false
         OR attention_reason IS NULL
         OR attention_reason LIKE 'Delivery failed:%'
         OR attention_reason LIKE 'Delivery unconfirmed:%'
       )
     RETURNING *`,
    [reason, id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);

  // A delivery failure is worth surfacing even when a more important human
  // attention reason is already protecting the contact row from being replaced.
  notifyTelegram(
    telegramImmediateAlerts.sendDeliveryFailureAlert({ contactId: id, reason }),
    "delivery failure",
    id
  );

  return updated;
}

// Clears only a delivery attention flag and only when no failed or unconfirmed
// outbound messages remain. Keeping both conditions in the same SQL statement
// prevents a successful retry from clearing a newer keyword, handoff, or
// staff-owned-message warning that arrived while the retry was in progress.
async function clearDeliveryAttentionIfNoFailedMessages(id) {
  const result = await pool.query(
    `UPDATE contacts c
     SET needs_attention = false, attention_reason = NULL, updated_at = now()
     WHERE c.id = $1
       AND c.needs_attention = true
       AND (
         c.attention_reason LIKE 'Delivery failed:%'
         OR c.attention_reason LIKE 'Delivery unconfirmed:%'
       )
       AND NOT EXISTS (
         SELECT 1 FROM messages m
         WHERE m.contact_id = c.id
           AND m.role = 'assistant'
           AND m.delivery_status IN ('failed', 'unknown')
       )
     RETURNING *`,
    [id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function setUnread(id, isUnread) {
  const result = await pool.query(
    `UPDATE contacts
     SET is_unread = $1, updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [isUnread, id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);
  return updated;
}

async function setFollowUp(id, needsFollowUp) {
  const result = await pool.query(
    `UPDATE contacts
     SET needs_follow_up = $1, updated_at = now()
     WHERE id = $2
     RETURNING *`,
    [needsFollowUp, id]
  );
  const updated = result.rows[0] || null;
  if (updated) publishContactChange(updated.id);
  return updated;
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
  setDeliveryAttention,
  clearDeliveryAttentionIfNoFailedMessages,
  setUnread,
  setFollowUp,
};
