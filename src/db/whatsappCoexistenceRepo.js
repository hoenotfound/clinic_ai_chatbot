const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");

async function persistStaffEchoIfNew(
  contactId,
  content,
  whatsappMessageId,
  actor,
  syntheticHandoffOwner,
  queryable = null
) {
  const ownsClient = queryable == null;
  const client = ownsClient ? await pool.connect() : queryable;
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
      // The webhook may be a Meta retry after this echo was already persisted.
      // Return the existing durable state so post-ACK side effects such as
      // pipeline alignment can be retried idempotently, but do not change
      // ownership again.
      const existingMessage = await client.query(
        `SELECT id, contact_id, role, content, whatsapp_message_id,
                sent_by_username, media_url,
                (media_key IS NOT NULL) AS has_media_attachment,
                media_mime_type, created_at, delivery_status, delivery_error,
                is_automated_follow_up
         FROM messages
         WHERE whatsapp_message_id = $1 AND contact_id = $2
         LIMIT 1`,
        [whatsappMessageId, contactId]
      );
      const existingContact = await client.query(
        "SELECT * FROM contacts WHERE id = $1",
        [contactId]
      );
      await client.query("COMMIT");
      const prior = existingMessage.rows[0] || null;
      const contact = existingContact.rows[0] || null;
      return prior && contact ? { contact, message: prior, isNew: false } : null;
    }

    const updated = await client.query(
      `UPDATE contacts
       SET mode = 'human',
           takeover_by = CASE
             WHEN mode = 'human'
              AND takeover_by IS NOT NULL
              AND takeover_by IS DISTINCT FROM $3
             THEN takeover_by
             ELSE $1
           END,
           takeover_at = CASE
             WHEN mode = 'human'
              AND takeover_by IS NOT NULL
              AND takeover_by IS DISTINCT FROM $3
             THEN takeover_at
             ELSE now()
           END,
           needs_attention = false,
           attention_reason = NULL,
           is_unread = false,
           updated_at = now()
       WHERE id = $2
       RETURNING *`,
      [actor, contactId, syntheticHandoffOwner || null]
    );

    const contact = updated.rows[0] || null;
    if (!contact) {
      throw new Error(`Contact ${contactId} disappeared while storing a Business App echo.`);
    }

    await client.query("COMMIT");
    return { contact, message, isNew: true };
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
