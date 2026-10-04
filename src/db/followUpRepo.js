const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");

const MAX_FOLLOW_UP_STEPS = 3;
const REPLY_WINDOW_BUFFER = "23 hours 50 minutes";

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
  is_automated_follow_up,
  automated_follow_up_step,
  automated_follow_up_target_service,
  automated_follow_up_targeting_recorded
`;

function normalizeDelayMinutes(value) {
  const source = Array.isArray(value) ? value : [value];
  const delays = source.map((item) => Number(item));
  if (
    delays.length < 1 ||
    delays.length > MAX_FOLLOW_UP_STEPS ||
    delays.some(
      (minutes) =>
        !Number.isInteger(minutes) ||
        minutes < 5 ||
        minutes > 23 * 60
    )
  ) {
    throw new TypeError("Follow-up delays must contain 1 to 3 integer minute values between 5 minutes and 23 hours.");
  }
  for (let index = 1; index < delays.length; index += 1) {
    if (delays[index] <= delays[index - 1]) {
      throw new TypeError("Follow-up delays must increase for each sequence step.");
    }
  }
  return delays;
}

/**
 * Returns conversations whose latest normal outbound reply can advance to the
 * next configured follow-up sequence step. A customer reply starts a new cycle,
 * while a newer normal AI/staff reply becomes the new anchor automatically.
 *
 * Failed, unknown, or not-yet-provider-confirmed sequence claims block later
 * steps. This keeps the worker from progressing past a send that staff may need
 * to inspect or retry.
 */
async function findCandidates({ delayMinutes, triggerMode, activatedAt, limit = 25 }) {
  const delays = normalizeDelayMinutes(delayMinutes);
  const result = await pool.query(
    `WITH conversation_state AS (
       SELECT
         c.id AS contact_id,
         c.channel,
         c.whatsapp_number,
         c.channel_user_id,
         anchor.id AS trigger_message_id,
         anchor.content AS trigger_message_content,
         anchor.created_at AS trigger_created_at,
         latest_inbound.created_at AS latest_inbound_created_at,
         COALESCE(progress.max_step, 0) + 1 AS next_follow_up_step,
         COALESCE(progress.has_blocking_claim, false) AS has_blocking_claim,
         latest_lead.treatment_interest,
         ARRAY(
           SELECT recent_inbound.content
           FROM messages recent_inbound
           WHERE recent_inbound.contact_id = c.id
             AND recent_inbound.role = 'user'
             AND recent_inbound.id <= latest_inbound.id
             AND (
               previous_outbound.id IS NULL
               OR recent_inbound.id > previous_outbound.id
             )
           ORDER BY recent_inbound.created_at DESC, recent_inbound.id DESC
           LIMIT 5
         ) AS recent_inbound_messages
       FROM contacts c
       JOIN LATERAL (
         SELECT id, created_at
         FROM messages
         WHERE contact_id = c.id
           AND role = 'user'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) latest_inbound ON true
       LEFT JOIN LATERAL (
         SELECT id
         FROM messages
         WHERE contact_id = c.id
           AND role = 'assistant'
           AND (created_at, id) <
               (latest_inbound.created_at, latest_inbound.id)
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) previous_outbound ON true
       JOIN LATERAL (
         SELECT id, content, sent_by_username, created_at, delivery_status
         FROM messages
         WHERE contact_id = c.id
           AND role = 'assistant'
           AND is_automated_follow_up = false
           AND (created_at, id) >
               (latest_inbound.created_at, latest_inbound.id)
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) anchor ON true
       LEFT JOIN LATERAL (
         SELECT
           MAX(follow_up.automated_follow_up_step) AS max_step,
           BOOL_OR(
             follow_up.delivery_status IN ('failed', 'unknown')
             OR (
               follow_up.delivery_status IS NULL
               AND follow_up.whatsapp_message_id IS NULL
             )
           ) AS has_blocking_claim
         FROM messages follow_up
         WHERE follow_up.contact_id = c.id
           AND follow_up.is_automated_follow_up = true
           AND follow_up.automated_follow_up_for_message_id = anchor.id
       ) progress ON true
       LEFT JOIN LATERAL (
         SELECT
           l.id,
           l.treatment_interest,
           l.is_closed,
           l.appointment_status,
           s.stage_type,
           s.system_key
         FROM leads l
         LEFT JOIN pipeline_stages s ON s.id = l.stage_id
         WHERE l.contact_id = c.id
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT 1
       ) latest_lead ON true
       WHERE c.channel IN ('whatsapp', 'facebook', 'instagram')
         AND c.needs_attention = false
         AND (
           (c.channel = 'whatsapp' AND c.whatsapp_number IS NOT NULL)
           OR (c.channel IN ('facebook', 'instagram') AND c.channel_user_id IS NOT NULL)
         )
         AND anchor.delivery_status IS DISTINCT FROM 'failed'
         AND (
           latest_lead.id IS NULL
           OR (
             latest_lead.is_closed = false
             AND (
               COALESCE(latest_lead.appointment_status, 'none') IN ('reschedule', 'cancelled')
               OR (
                 COALESCE(latest_lead.stage_type, 'open') = 'open'
                 AND COALESCE(latest_lead.system_key, '') NOT IN ('appointment_set', 'visited')
                 AND COALESCE(latest_lead.appointment_status, 'none') NOT IN ('set', 'visited')
               )
             )
           )
         )
         AND anchor.created_at >= $3::timestamptz
         AND latest_inbound.created_at > now() - interval '23 hours 50 minutes'
         AND ($2 = 'all' OR anchor.sent_by_username IS NOT NULL)
     )
     SELECT
       contact_id,
       channel,
       whatsapp_number,
       channel_user_id,
       trigger_message_id,
       trigger_message_content,
       recent_inbound_messages,
       treatment_interest,
       next_follow_up_step
     FROM conversation_state
     WHERE next_follow_up_step <= cardinality($1::integer[])
       AND has_blocking_claim = false
       AND trigger_created_at
             + (($1::integer[])[next_follow_up_step] * interval '1 minute') <= now()
       AND trigger_created_at
             + (($1::integer[])[next_follow_up_step] * interval '1 minute')
           <= latest_inbound_created_at + interval '23 hours 50 minutes'
     ORDER BY
       trigger_created_at
         + (($1::integer[])[next_follow_up_step] * interval '1 minute') ASC,
       contact_id ASC
     LIMIT $4`,
    [delays, triggerMode, activatedAt, limit]
  );
  return result.rows;
}

/**
 * Returns the earliest due time for the next eligible sequence step. The worker
 * sleeps until this timestamp rather than polling Postgres every minute.
 */
async function getNextCandidateDueAt({ delayMinutes, triggerMode, activatedAt }) {
  const delays = normalizeDelayMinutes(delayMinutes);
  const result = await pool.query(
    `WITH conversation_state AS (
       SELECT
         c.id AS contact_id,
         anchor.id AS trigger_message_id,
         anchor.created_at AS trigger_created_at,
         latest_inbound.created_at AS latest_inbound_created_at,
         COALESCE(progress.max_step, 0) + 1 AS next_follow_up_step,
         COALESCE(progress.has_blocking_claim, false) AS has_blocking_claim
       FROM contacts c
       JOIN LATERAL (
         SELECT id, created_at
         FROM messages
         WHERE contact_id = c.id
           AND role = 'user'
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) latest_inbound ON true
       JOIN LATERAL (
         SELECT id, sent_by_username, created_at, delivery_status
         FROM messages
         WHERE contact_id = c.id
           AND role = 'assistant'
           AND is_automated_follow_up = false
           AND (created_at, id) >
               (latest_inbound.created_at, latest_inbound.id)
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) anchor ON true
       LEFT JOIN LATERAL (
         SELECT
           MAX(follow_up.automated_follow_up_step) AS max_step,
           BOOL_OR(
             follow_up.delivery_status IN ('failed', 'unknown')
             OR (
               follow_up.delivery_status IS NULL
               AND follow_up.whatsapp_message_id IS NULL
             )
           ) AS has_blocking_claim
         FROM messages follow_up
         WHERE follow_up.contact_id = c.id
           AND follow_up.is_automated_follow_up = true
           AND follow_up.automated_follow_up_for_message_id = anchor.id
       ) progress ON true
       LEFT JOIN LATERAL (
         SELECT
           l.id,
           l.is_closed,
           l.appointment_status,
           s.stage_type,
           s.system_key
         FROM leads l
         LEFT JOIN pipeline_stages s ON s.id = l.stage_id
         WHERE l.contact_id = c.id
         ORDER BY l.created_at DESC, l.id DESC
         LIMIT 1
       ) latest_lead ON true
       WHERE c.channel IN ('whatsapp', 'facebook', 'instagram')
         AND c.needs_attention = false
         AND (
           (c.channel = 'whatsapp' AND c.whatsapp_number IS NOT NULL)
           OR (c.channel IN ('facebook', 'instagram') AND c.channel_user_id IS NOT NULL)
         )
         AND anchor.delivery_status IS DISTINCT FROM 'failed'
         AND (
           latest_lead.id IS NULL
           OR (
             latest_lead.is_closed = false
             AND (
               COALESCE(latest_lead.appointment_status, 'none') IN ('reschedule', 'cancelled')
               OR (
                 COALESCE(latest_lead.stage_type, 'open') = 'open'
                 AND COALESCE(latest_lead.system_key, '') NOT IN ('appointment_set', 'visited')
                 AND COALESCE(latest_lead.appointment_status, 'none') NOT IN ('set', 'visited')
               )
             )
           )
         )
         AND anchor.created_at >= $3::timestamptz
         AND latest_inbound.created_at > now() - interval '23 hours 50 minutes'
         AND ($2 = 'all' OR anchor.sent_by_username IS NOT NULL)
     )
     SELECT MIN(
       trigger_created_at
         + (($1::integer[])[next_follow_up_step] * interval '1 minute')
     ) AS due_at
     FROM conversation_state
     WHERE next_follow_up_step <= cardinality($1::integer[])
       AND has_blocking_claim = false
       AND trigger_created_at
             + (($1::integer[])[next_follow_up_step] * interval '1 minute')
           <= latest_inbound_created_at + interval '23 hours 50 minutes'`,
    [delays, triggerMode, activatedAt]
  );
  return result.rows[0]?.due_at || null;
}

/**
 * Returns when the earliest unconfirmed follow-up claim becomes stale enough
 * to surface to staff.
 */
async function getNextStaleClaimDueAt({ olderThanMinutes }) {
  const result = await pool.query(
    `SELECT MIN(created_at + ($1::integer * interval '1 minute')) AS due_at
     FROM messages
     WHERE is_automated_follow_up = true
       AND whatsapp_message_id IS NULL
       AND delivery_status IS NULL`,
    [olderThanMinutes]
  );
  return result.rows[0]?.due_at || null;
}

/**
 * Atomically claims one sequence step. The advisory lock serializes competing
 * workers for the same conversation, while the database unique key on
 * (trigger message, step) is the final duplicate-send guard.
 */
async function saveIfStillEligible({
  contactId,
  triggerMessageId,
  content,
  mediaUrl,
  stepIndex = 1,
  targetedService = null,
  delayMinutes,
  triggerMode,
  activatedAt,
}) {
  const numericDelay = Number(delayMinutes);
  const numericStep = Number(stepIndex);
  if (
    !Number.isInteger(numericDelay) ||
    numericDelay < 5 ||
    numericDelay > 23 * 60 ||
    !Number.isInteger(numericStep) ||
    numericStep < 1 ||
    numericStep > MAX_FOLLOW_UP_STEPS
  ) {
    throw new TypeError("Invalid automated follow-up step or delay.");
  }

  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     ), latest_inbound AS (
       SELECT id, created_at
       FROM messages, conversation_lock
       WHERE contact_id = $1
         AND role = 'user'
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ), anchor AS (
       SELECT id, sent_by_username, created_at, delivery_status
       FROM messages, latest_inbound
       WHERE contact_id = $1
         AND role = 'assistant'
         AND is_automated_follow_up = false
         AND (created_at, id) >
             (latest_inbound.created_at, latest_inbound.id)
       ORDER BY created_at DESC, id DESC
       LIMIT 1
     ), progress AS (
       SELECT
         MAX(follow_up.automated_follow_up_step) AS max_step,
         BOOL_OR(
           follow_up.delivery_status IN ('failed', 'unknown')
           OR (
             follow_up.delivery_status IS NULL
             AND follow_up.whatsapp_message_id IS NULL
           )
         ) AS has_blocking_claim
       FROM messages follow_up, anchor
       WHERE follow_up.contact_id = $1
         AND follow_up.is_automated_follow_up = true
         AND follow_up.automated_follow_up_for_message_id = anchor.id
     )
     INSERT INTO messages (
       contact_id,
       role,
       content,
       sent_by_username,
       media_url,
       is_automated_follow_up,
       automated_follow_up_for_message_id,
       automated_follow_up_step,
       automated_follow_up_target_service,
       automated_follow_up_targeting_recorded
     )
     SELECT $1, 'assistant', $3, 'Follow-up automation', $4, true, $2, $5, $6, true
     FROM anchor, latest_inbound, progress, contacts c
     LEFT JOIN LATERAL (
       SELECT
         l.id,
         l.is_closed,
         l.appointment_status,
         s.stage_type,
         s.system_key
       FROM leads l
       LEFT JOIN pipeline_stages s ON s.id = l.stage_id
       WHERE l.contact_id = c.id
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT 1
     ) latest_lead ON true
     WHERE c.id = $1
       AND c.needs_attention = false
       AND c.channel IN ('whatsapp', 'facebook', 'instagram')
       AND (
         (c.channel = 'whatsapp' AND c.whatsapp_number IS NOT NULL)
         OR (c.channel IN ('facebook', 'instagram') AND c.channel_user_id IS NOT NULL)
       )
       AND anchor.id = $2
       AND anchor.delivery_status IS DISTINCT FROM 'failed'
       AND (
         latest_lead.id IS NULL
         OR (
           latest_lead.is_closed = false
           AND (
             COALESCE(latest_lead.appointment_status, 'none') IN ('reschedule', 'cancelled')
             OR (
               COALESCE(latest_lead.stage_type, 'open') = 'open'
               AND COALESCE(latest_lead.system_key, '') NOT IN ('appointment_set', 'visited')
               AND COALESCE(latest_lead.appointment_status, 'none') NOT IN ('set', 'visited')
             )
           )
         )
       )
       AND anchor.created_at >= $9::timestamptz
       AND anchor.created_at <= now() - ($7::integer * interval '1 minute')
       AND anchor.created_at + ($7::integer * interval '1 minute')
           <= latest_inbound.created_at + interval '23 hours 50 minutes'
       AND ($8 = 'all' OR anchor.sent_by_username IS NOT NULL)
       AND COALESCE(progress.max_step, 0) + 1 = $5
       AND COALESCE(progress.has_blocking_claim, false) = false
     ON CONFLICT DO NOTHING
     RETURNING ${FOLLOW_UP_MESSAGE_COLUMNS}`,
    [
      contactId,
      triggerMessageId,
      content,
      mediaUrl,
      numericStep,
      typeof targetedService === "string" && targetedService.trim()
        ? targetedService.trim()
        : null,
      numericDelay,
      triggerMode,
      activatedAt,
    ]
  );
  return result.rows[0] || null;
}

/**
 * Facebook Messenger and Instagram send text and linked images as separate
 * Meta messages. Companion image rows do not participate in sequence progress
 * because they have no trigger-message anchor.
 */
async function saveSocialImageCompanion({ contactId, imageUrl }) {
  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     )
     INSERT INTO messages (
       contact_id,
       role,
       content,
       sent_by_username,
       media_url,
       is_automated_follow_up
     )
     SELECT $1, 'assistant', '', 'Follow-up automation', $2, true
     FROM conversation_lock
     RETURNING ${FOLLOW_UP_MESSAGE_COLUMNS}`,
    [contactId, imageUrl]
  );
  return result.rows[0] || null;
}

/**
 * A process can stop after claiming a follow-up but before it records the
 * provider response. Surface those rows as unconfirmed instead of blindly
 * resending and risking a duplicate.
 */
async function markStaleClaimsUnconfirmed({ olderThanMinutes, limit = 25 }) {
  const result = await pool.query(
    `UPDATE messages
     SET delivery_status = 'unknown',
         delivery_error = 'Delivery could not be confirmed because the server restarted during this automated follow-up. Check the customer chat before retrying to avoid sending it twice.'
     WHERE id IN (
       SELECT id
       FROM messages
       WHERE is_automated_follow_up = true
         AND whatsapp_message_id IS NULL
         AND delivery_status IS NULL
         AND created_at <= now() - ($1::integer * interval '1 minute')
       ORDER BY created_at ASC, id ASC
       LIMIT $2
       FOR UPDATE SKIP LOCKED
     )
     RETURNING ${FOLLOW_UP_MESSAGE_COLUMNS}`,
    [olderThanMinutes, limit]
  );
  return result.rows;
}

module.exports = {
  MAX_FOLLOW_UP_STEPS,
  findCandidates,
  getNextCandidateDueAt,
  getNextStaleClaimDueAt,
  saveIfStillEligible,
  saveSocialImageCompanion,
  markStaleClaimsUnconfirmed,
};
