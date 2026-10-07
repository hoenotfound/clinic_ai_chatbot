const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");

async function persistStaffEchoIfNew(
  contactId,
  content,
  providerMessageId,
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

    // Multipart social sends can have more than one Meta MID for one Inbox
    // bubble (for example Instagram caption + image). The outbound path records
    // every MID in social_provider_message_ids under this same conversation
    // lock. If this echo belongs to one of those MIDs, it is our own send and
    // must not create a duplicate or alter conversation ownership.
    const knownOutbound = await client.query(
      `SELECT m.id, m.contact_id, m.role, m.content, m.whatsapp_message_id,
              m.sent_by_username, m.media_url,
              (m.media_key IS NOT NULL) AS has_media_attachment,
              m.media_mime_type, m.created_at, m.delivery_status,
              m.delivery_error, m.is_automated_follow_up
       FROM social_provider_message_ids s
       JOIN messages m ON m.id = s.message_id
       WHERE s.provider_message_id = $1
         AND s.contact_id = $2
       LIMIT 1`,
      [providerMessageId, contactId]
    );
    if (knownOutbound.rows[0]) {
      const existingContact = await client.query(
        "SELECT * FROM contacts WHERE id = $1",
        [contactId]
      );
      await client.query("COMMIT");
      return existingContact.rows[0]
        ? {
            contact: existingContact.rows[0],
            message: knownOutbound.rows[0],
            isNew: false,
            isOutbound: true,
          }
        : null;
    }

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
      [contactId, content, providerMessageId, actor]
    );

    const message = inserted.rows[0] || null;
    if (!message) {
      const existingMessage = await client.query(
        `SELECT id, contact_id, role, content, whatsapp_message_id,
                sent_by_username, media_url,
                (media_key IS NOT NULL) AS has_media_attachment,
                media_mime_type, created_at, delivery_status, delivery_error,
                is_automated_follow_up
         FROM messages
         WHERE whatsapp_message_id = $1 AND contact_id = $2
         LIMIT 1`,
        [providerMessageId, contactId]
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

    // If this staff reply is claiming a synthetic AI handoff, cancel the old
    // AI-started follow-up anchor before this new staff row can become the
    // effective outbound anchor after Return to AI.
    await client.query(
      `WITH eligible_contact AS (
         SELECT id
         FROM contacts
         WHERE id = $1
           AND mode = 'human'
           AND takeover_by = $3
       ), latest_inbound AS (
         SELECT inbound.id, inbound.created_at
         FROM messages inbound, eligible_contact
         WHERE inbound.contact_id = eligible_contact.id
           AND inbound.role = 'user'
         ORDER BY inbound.created_at DESC, inbound.id DESC
         LIMIT 1
       ), anchor AS (
         SELECT outbound.id, outbound.sent_by_username
         FROM messages outbound, eligible_contact, latest_inbound
         WHERE outbound.contact_id = eligible_contact.id
           AND outbound.role = 'assistant'
           AND outbound.is_automated_follow_up = false
           AND (outbound.created_at, outbound.id) >
               (latest_inbound.created_at, latest_inbound.id)
           AND (outbound.created_at, outbound.id) <
               (SELECT staff_message.created_at, staff_message.id
                FROM messages staff_message
                WHERE staff_message.id = $2::bigint
                  AND staff_message.contact_id = $1)
         ORDER BY outbound.created_at DESC, outbound.id DESC
         LIMIT 1
       )
       INSERT INTO follow_up_ai_decisions (
         contact_id,
         trigger_message_id,
         follow_up_step,
         action,
         reason,
         topic
       )
       SELECT
         eligible_contact.id,
         anchor.id,
         1,
         'skip',
         'Cancelled because clinic staff claimed this AI handoff.',
         NULL
       FROM eligible_contact, anchor
       WHERE anchor.sent_by_username IS NULL
       ON CONFLICT (trigger_message_id, follow_up_step) DO NOTHING`,
      [
        contactId,
        message.id,
        syntheticHandoffOwner || null,
      ]
    );

    const updated = await client.query(
      `UPDATE contacts
       SET takeover_by = CASE
             WHEN mode = 'human'
              AND (takeover_by IS NULL OR takeover_by = $3)
             THEN $1
             WHEN mode = 'human'
             THEN takeover_by
             ELSE NULL
           END,
           takeover_at = CASE
             WHEN mode = 'human'
              AND (takeover_by IS NULL OR takeover_by = $3)
             THEN now()
             WHEN mode = 'human'
             THEN takeover_at
             ELSE NULL
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
      throw new Error(`Contact ${contactId} disappeared while storing a Meta staff echo.`);
    }

    await client.query("COMMIT");
    return { contact, message, isNew: true };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      console.error("Failed to roll back Meta staff echo transaction:", rollbackErr);
    }
    throw err;
  } finally {
    if (ownsClient) client.release();
  }
}

module.exports = {
  persistStaffEchoIfNew,
};
