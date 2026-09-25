const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");

async function persistStaffEchoIfNew(
  contactId,
  content,
  whatsappMessageId,
  actor,
  queryable = pool
) {
  const ownsClient = typeof queryable.connect === "function";
  const client = ownsClient ? await queryable.connect() : queryable;
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)`,
      [contactId]
    );

    const inserted = await client.query(
      `INSERT INTO messages (
         contact_id, role, content, whatsapp_message_id, sent_by_username
       )
       VALUES ($1, 'assistant', $2, $3, $4)
       ON CONFLICT (whatsapp_message_id) DO NOTHING
       RETURNING id, contact_id, role, content, whatsapp_message_id,
                 sent_by_username, media_url,
                 (media_key IS NOT NULL) AS has_media_attachment,
                 media_mime_type, created_at, delivery_status, delivery_error,
                 is_automated_follow_up`,
      [contactId, content, whatsappMessageId, actor]
    );

    const message = inserted.rows[0] || null;
    if (!message) {
      await client.query("COMMIT");
      return null;
    }

    const updated = await client.query(
      `UPDATE contacts
       SET mode = 'human',
           takeover_by = $1,
           takeover_at = now(),
           needs_attention = false,
           attention_reason = NULL,
           is_unread = false,
           updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [actor, contactId]
    );

    const contact = updated.rows[0] || null;
    if (!contact) {
      throw new Error(`Contact ${contactId} disappeared while storing a Business App echo.`);
    }

    await client.query("COMMIT");
    return { contact, message };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Failed to roll back Business App echo transaction:", rollbackErr);
    }
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

module.exports = {
  persistStaffEchoIfNew,
};
