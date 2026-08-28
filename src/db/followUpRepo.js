const { pool } = require("./db");

const FOLLOW_UP_MESSAGE_COLUMNS = `
  id,
  contact_id,
  role,
  content,
  whatsapp_message_id,
  sent_by_username,
  media_url,
  false AS has_media_attachment,
  media_mime_type,
  created_at,
  delivery_status,
  delivery_error,
  is_automated_follow_up
`;

/**
 * Returns conversations whose newest message is a successful outbound
 * message and whose customer has stayed silent for the configured delay.
 * The WhatsApp session check leaves a small buffer before the 24-hour limit,
 * because free-form follow-ups outside that window require an approved
 * message template rather than the normal send-message endpoint.
 */
async function findCandidates({ delayMinutes, triggerMode, activatedAt, limit = 25 }) {
  const result = await pool.query(
    `SELECT
       c.id AS contact_id,
       c.whatsapp_number,
       latest.id AS trigger_message_id
     FROM contacts c
     JOIN LATERAL (
       SELECT id, role, sent_by_username, created_at, delivery_status,
              is_automated_follow_up
       FROM messages
       WHERE contact_id = c.id
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) latest ON true
     JOIN LATERAL (
       SELECT id, created_at
       FROM messages
       WHERE contact_id = c.id AND role = 'user'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ) latest_inbound ON true
     WHERE c.channel = 'whatsapp'
       AND latest.role = 'assistant'
       AND latest.is_automated_follow_up = false
       AND latest.delivery_status IS DISTINCT FROM 'failed'
       AND latest.created_at >= $3::timestamptz
       AND latest.created_at <= now() - ($1::integer * interval '1 minute')
       AND latest_inbound.created_at > now() - interval '23 hours 50 minutes'
       AND ($2 = 'all' OR latest.sent_by_username IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1
         FROM messages follow_up
         WHERE follow_up.automated_follow_up_for_message_id = latest.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM messages follow_up
         WHERE follow_up.contact_id = c.id
           AND follow_up.is_automated_follow_up = true
           AND (follow_up.created_at, follow_up.id) >
               (latest_inbound.created_at, latest_inbound.id)
       )
     ORDER BY latest.created_at ASC
     LIMIT $4`,
    [delayMinutes, triggerMode, activatedAt, limit]
  );
  return result.rows;
}

/**
 * Atomically claims a follow-up by inserting its Inbox message only if the
 * trigger is still the conversation's newest message. The unique trigger
 * index is the second guard against duplicate sends across server instances.
 */
async function saveIfStillEligible({
  contactId,
  triggerMessageId,
  content,
  mediaUrl,
  delayMinutes,
  triggerMode,
  activatedAt,
}) {
  const result = await pool.query(
    `WITH latest AS (
       SELECT id, role, sent_by_username, created_at, delivery_status,
              is_automated_follow_up
       FROM messages
       WHERE contact_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ), latest_inbound AS (
       SELECT id, created_at
       FROM messages
       WHERE contact_id = $1 AND role = 'user'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     )
     INSERT INTO messages (
       contact_id,
       role,
       content,
       sent_by_username,
       media_url,
       is_automated_follow_up,
       automated_follow_up_for_message_id
     )
     SELECT $1, 'assistant', $3, 'Follow-up automation', $4, true, $2
     FROM latest, latest_inbound
     WHERE latest.id = $2
       AND latest.role = 'assistant'
       AND latest.is_automated_follow_up = false
       AND latest.delivery_status IS DISTINCT FROM 'failed'
       AND latest.created_at >= $7::timestamptz
       AND latest.created_at <= now() - ($5::integer * interval '1 minute')
       AND latest_inbound.created_at > now() - interval '23 hours 50 minutes'
       AND ($6 = 'all' OR latest.sent_by_username IS NOT NULL)
       AND NOT EXISTS (
         SELECT 1
         FROM messages prior_follow_up
         WHERE prior_follow_up.contact_id = $1
           AND prior_follow_up.is_automated_follow_up = true
           AND (prior_follow_up.created_at, prior_follow_up.id) >
               (latest_inbound.created_at, latest_inbound.id)
       )
     ON CONFLICT DO NOTHING
     RETURNING ${FOLLOW_UP_MESSAGE_COLUMNS}`,
    [contactId, triggerMessageId, content, mediaUrl, delayMinutes, triggerMode, activatedAt]
  );
  return result.rows[0] || null;
}

module.exports = { findCandidates, saveIfStillEligible };
