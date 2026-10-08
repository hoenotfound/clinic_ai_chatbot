const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");
const { beforeExpiryDueSql } = require("../utils/followUpAdaptiveTiming");
const clinicConfig = require("../config/clinicConfig");
function reserveFinalPricingWindow() {
  const config=clinicConfig.automatedFollowUp;
  return config?.enabled === true && config?.pricingReminder?.enabled === true;
}


const MAX_FOLLOW_UP_STEPS = 3;
const REPLY_WINDOW_BUFFER = "23 hours 50 minutes";
const FOLLOW_UP_MESSAGE_MODES = new Set(["fixed", "ai_personalized", "ai_fallback"]);

const FOLLOW_UP_MESSAGE_COLUMNS = `
  id,
  contact_id,
  role,
  content,
  whatsapp_message_id,
  sent_by_username,
  media_url,
  (media_key IS NOT NULL) AS has_media_attachment,
  media_mime_type,
  created_at,
  delivery_status,
  delivery_error,
  is_automated_follow_up,
  automated_follow_up_step,
  automated_follow_up_target_service,
  automated_follow_up_targeting_recorded,
  automated_follow_up_message_mode
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

function normalizeTimingModes(value, count) {
  const source = Array.isArray(value)
    ? value
    : Array.from({ length: count }, () => "after_reply");
  if (
    source.length !== count ||
    source.some(
      (mode) => !["after_reply", "before_window_expiry"].includes(mode)
    )
  ) {
    throw new TypeError("Invalid automated follow-up timing mode.");
  }
  return source;
}

function normalizeBeforeWindowExpiryMinutes(value, count) {
  const source = Array.isArray(value)
    ? value
    : Array.from({ length: count }, () => 120);
  const minutes = source.map((item) => Number(item));
  if (
    minutes.length !== count ||
    minutes.some(
      (item) =>
        !Number.isInteger(item) ||
        item < 60 ||
        item > 360
    )
  ) {
    throw new TypeError("Invalid automated follow-up expiry offset.");
  }
  return minutes;
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
async function findCandidates({
  delayMinutes,
  timingModes,
  beforeWindowExpiryMinutes,
  triggerMode,
  activatedAt,
  quietHours,
  limit = 25,
}) {
  const delays = normalizeDelayMinutes(delayMinutes);
  const modes = normalizeTimingModes(timingModes, delays.length);
  const expiryOffsets = normalizeBeforeWindowExpiryMinutes(
    beforeWindowExpiryMinutes,
    delays.length
  );
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
         previous_follow_up.created_at AS previous_follow_up_created_at,
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
         ) AS recent_inbound_messages,
         ARRAY(
           SELECT service_inbound.content
           FROM messages service_inbound
           WHERE service_inbound.contact_id = c.id
             AND service_inbound.role = 'user'
             AND service_inbound.id <= latest_inbound.id
             AND service_inbound.created_at >=
                 latest_inbound.created_at - interval '24 hours'
           ORDER BY service_inbound.created_at DESC, service_inbound.id DESC
           LIMIT 10
         ) AS recent_service_messages
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
            AND NOT EXISTS (
              SELECT 1
              FROM outbound_message_evidence evidence
              WHERE evidence.message_id = messages.id
                AND evidence.origin = 'system_fallback'
            )
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
         SELECT follow_up.created_at
         FROM messages follow_up
         WHERE follow_up.contact_id = c.id
           AND follow_up.is_automated_follow_up = true
           AND follow_up.automated_follow_up_for_message_id = anchor.id
           AND follow_up.automated_follow_up_step = progress.max_step
         ORDER BY follow_up.created_at DESC, follow_up.id DESC
         LIMIT 1
       ) previous_follow_up ON true
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
             AND COALESCE(latest_lead.stage_type, 'open') = 'open'
             AND (
               COALESCE(latest_lead.appointment_status, 'none') IN ('reschedule', 'cancelled')
               OR (
                 COALESCE(latest_lead.system_key, '') NOT IN ('appointment_set', 'visited')
                 AND COALESCE(latest_lead.appointment_status, 'none') NOT IN ('set', 'visited')
               )
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM follow_up_ai_decisions decision
           WHERE decision.contact_id = c.id
             AND decision.trigger_message_id = anchor.id
             AND decision.action IN ('skip', 'human_review')
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
       recent_service_messages,
       treatment_interest,
       next_follow_up_step
     FROM conversation_state
     WHERE next_follow_up_step <= cardinality($1::integer[])
       AND has_blocking_claim = false
       AND CASE
             WHEN ($5::text[])[next_follow_up_step] = 'before_window_expiry'
               THEN ${beforeExpiryDueSql({inbound:"latest_inbound_created_at",previous:"previous_follow_up_created_at",step:"next_follow_up_step",offset:"($6::integer[])[next_follow_up_step]",gap:"(($1::integer[])[next_follow_up_step] - ($1::integer[])[next_follow_up_step - 1])",quietHours})}
             ELSE GREATEST(
               trigger_created_at + (($1::integer[])[next_follow_up_step] * interval '1 minute'),
               COALESCE(
                 previous_follow_up_created_at
                   + ((($1::integer[])[next_follow_up_step] - ($1::integer[])[next_follow_up_step - 1]) * interval '1 minute'),
                 trigger_created_at + (($1::integer[])[next_follow_up_step] * interval '1 minute')
               )
             )
           END <= now()
       AND CASE
             WHEN ($5::text[])[next_follow_up_step] = 'before_window_expiry'
               THEN ${beforeExpiryDueSql({inbound:"latest_inbound_created_at",previous:"previous_follow_up_created_at",step:"next_follow_up_step",offset:"($6::integer[])[next_follow_up_step]",gap:"(($1::integer[])[next_follow_up_step] - ($1::integer[])[next_follow_up_step - 1])",quietHours})}
             ELSE GREATEST(
               trigger_created_at + (($1::integer[])[next_follow_up_step] * interval '1 minute'),
               COALESCE(
                 previous_follow_up_created_at
                   + ((($1::integer[])[next_follow_up_step] - ($1::integer[])[next_follow_up_step - 1]) * interval '1 minute'),
                 trigger_created_at + (($1::integer[])[next_follow_up_step] * interval '1 minute')
               )
             )
           END <= latest_inbound_created_at + interval '23 hours 50 minutes'
       AND ${reserveFinalPricingWindow()
         ? "(next_follow_up_step <> 3 OR now() < latest_inbound_created_at + interval '23 hours 35 minutes')"
         : "TRUE"}
     ORDER BY
       CASE
             WHEN ($5::text[])[next_follow_up_step] = 'before_window_expiry'
               THEN ${beforeExpiryDueSql({inbound:"latest_inbound_created_at",previous:"previous_follow_up_created_at",step:"next_follow_up_step",offset:"($6::integer[])[next_follow_up_step]",gap:"(($1::integer[])[next_follow_up_step] - ($1::integer[])[next_follow_up_step - 1])",quietHours})}
             ELSE GREATEST(
               trigger_created_at + (($1::integer[])[next_follow_up_step] * interval '1 minute'),
               COALESCE(
                 previous_follow_up_created_at
                   + ((($1::integer[])[next_follow_up_step] - ($1::integer[])[next_follow_up_step - 1]) * interval '1 minute'),
                 trigger_created_at + (($1::integer[])[next_follow_up_step] * interval '1 minute')
               )
             )
           END ASC,
       contact_id ASC
     LIMIT $4`,
    [delays, triggerMode, activatedAt, limit, modes, expiryOffsets]
  );
  return result.rows;
}

/**
 * Returns the earliest due time for the next eligible sequence step. The worker
 * sleeps until this timestamp rather than polling Postgres every minute.
 */
async function getNextCandidateDueAt({
  delayMinutes,
  timingModes,
  beforeWindowExpiryMinutes,
  triggerMode,
  activatedAt,
  quietHours,
}) {
  const delays = normalizeDelayMinutes(delayMinutes);
  const modes = normalizeTimingModes(timingModes, delays.length);
  const expiryOffsets = normalizeBeforeWindowExpiryMinutes(
    beforeWindowExpiryMinutes,
    delays.length
  );
  const result = await pool.query(
    `WITH conversation_state AS (
       SELECT
         c.id AS contact_id,
         anchor.id AS trigger_message_id,
         anchor.created_at AS trigger_created_at,
         latest_inbound.created_at AS latest_inbound_created_at,
         COALESCE(progress.max_step, 0) + 1 AS next_follow_up_step,
         COALESCE(progress.has_blocking_claim, false) AS has_blocking_claim,
         previous_follow_up.created_at AS previous_follow_up_created_at
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
            AND NOT EXISTS (
              SELECT 1
              FROM outbound_message_evidence evidence
              WHERE evidence.message_id = messages.id
                AND evidence.origin = 'system_fallback'
            )
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
         SELECT follow_up.created_at
         FROM messages follow_up
         WHERE follow_up.contact_id = c.id
           AND follow_up.is_automated_follow_up = true
           AND follow_up.automated_follow_up_for_message_id = anchor.id
           AND follow_up.automated_follow_up_step = progress.max_step
         ORDER BY follow_up.created_at DESC, follow_up.id DESC
         LIMIT 1
       ) previous_follow_up ON true
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
             AND COALESCE(latest_lead.stage_type, 'open') = 'open'
             AND (
               COALESCE(latest_lead.appointment_status, 'none') IN ('reschedule', 'cancelled')
               OR (
                 COALESCE(latest_lead.system_key, '') NOT IN ('appointment_set', 'visited')
                 AND COALESCE(latest_lead.appointment_status, 'none') NOT IN ('set', 'visited')
               )
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM follow_up_ai_decisions decision
           WHERE decision.contact_id = c.id
             AND decision.trigger_message_id = anchor.id
             AND decision.action IN ('skip', 'human_review')
         )
         AND anchor.created_at >= $3::timestamptz
         AND latest_inbound.created_at > now() - interval '23 hours 50 minutes'
         AND ($2 = 'all' OR anchor.sent_by_username IS NOT NULL)
     )
     SELECT MIN(
       CASE
             WHEN ($4::text[])[next_follow_up_step] = 'before_window_expiry'
               THEN ${beforeExpiryDueSql({inbound:"latest_inbound_created_at",previous:"previous_follow_up_created_at",step:"next_follow_up_step",offset:"($5::integer[])[next_follow_up_step]",gap:"(($1::integer[])[next_follow_up_step] - ($1::integer[])[next_follow_up_step - 1])",quietHours})}
             ELSE GREATEST(
               trigger_created_at + (($1::integer[])[next_follow_up_step] * interval '1 minute'),
               COALESCE(
                 previous_follow_up_created_at
                   + ((($1::integer[])[next_follow_up_step] - ($1::integer[])[next_follow_up_step - 1]) * interval '1 minute'),
                 trigger_created_at + (($1::integer[])[next_follow_up_step] * interval '1 minute')
               )
             )
           END
     ) AS due_at
     FROM conversation_state
     WHERE next_follow_up_step <= cardinality($1::integer[])
       AND has_blocking_claim = false
       AND CASE
             WHEN ($4::text[])[next_follow_up_step] = 'before_window_expiry'
               THEN ${beforeExpiryDueSql({inbound:"latest_inbound_created_at",previous:"previous_follow_up_created_at",step:"next_follow_up_step",offset:"($5::integer[])[next_follow_up_step]",gap:"(($1::integer[])[next_follow_up_step] - ($1::integer[])[next_follow_up_step - 1])",quietHours})}
             ELSE GREATEST(
               trigger_created_at + (($1::integer[])[next_follow_up_step] * interval '1 minute'),
               COALESCE(
                 previous_follow_up_created_at
                   + ((($1::integer[])[next_follow_up_step] - ($1::integer[])[next_follow_up_step - 1]) * interval '1 minute'),
                 trigger_created_at + (($1::integer[])[next_follow_up_step] * interval '1 minute')
               )
             )
           END <= latest_inbound_created_at + interval '23 hours 50 minutes'
       AND ${reserveFinalPricingWindow()
         ? "(next_follow_up_step <> 3 OR now() < latest_inbound_created_at + interval '23 hours 35 minutes')"
         : "TRUE"}`,
    [delays, triggerMode, activatedAt, modes, expiryOffsets]
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
  mediaKey = null,
  mediaMimeType = null,
  stepIndex = 1,
  targetedService = null,
  messageMode = "fixed",
  delayMinutes,
  previousDelayMinutes = 0,
  timingMode = "after_reply",
  beforeWindowExpiryMinutes = 120,
  quietHours,
  triggerMode,
  activatedAt,
}) {
  const numericDelay = Number(delayMinutes);
  const numericPreviousDelay = Number(previousDelayMinutes);
  const numericBeforeWindowExpiryMinutes = Number(beforeWindowExpiryMinutes);
  const normalizedTimingMode =
    timingMode === "before_window_expiry"
      ? "before_window_expiry"
      : "after_reply";
  const numericStep = Number(stepIndex);
  const normalizedMessageMode = String(messageMode || "fixed").trim().toLowerCase();
  const normalizedMediaKey = String(mediaKey || "").trim() || null;
  const normalizedMediaMimeType = String(mediaMimeType || "").trim() || null;
  if (
    !Number.isInteger(numericDelay) ||
    numericDelay < 5 ||
    numericDelay > 23 * 60 ||
    !Number.isInteger(numericPreviousDelay) ||
    numericPreviousDelay < 0 ||
    numericPreviousDelay >= numericDelay ||
    (numericStep === 1 && numericPreviousDelay !== 0) ||
    (numericStep > 1 && numericPreviousDelay < 5) ||
    !Number.isInteger(numericBeforeWindowExpiryMinutes) ||
    numericBeforeWindowExpiryMinutes < 60 ||
    numericBeforeWindowExpiryMinutes > 360 ||
    (normalizedTimingMode === "before_window_expiry" &&
      numericDelay !== 24 * 60 - numericBeforeWindowExpiryMinutes) ||
    !Number.isInteger(numericStep) ||
    numericStep < 1 ||
    numericStep > MAX_FOLLOW_UP_STEPS ||
    !FOLLOW_UP_MESSAGE_MODES.has(normalizedMessageMode) ||
    (normalizedMediaKey && normalizedMediaMimeType !== "video/mp4") ||
    (!normalizedMediaKey && normalizedMediaMimeType)
  ) {
    throw new TypeError("Invalid automated follow-up step or delay.");
  }

  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     ), latest_inbound AS (
       SELECT inbound.id, inbound.created_at
       FROM messages inbound, conversation_lock
       WHERE inbound.contact_id = $1
         AND inbound.role = 'user'
       ORDER BY inbound.created_at DESC, inbound.id DESC
       LIMIT 1
     ), anchor AS (
       SELECT
         outbound.id,
         outbound.sent_by_username,
         outbound.created_at,
         outbound.delivery_status
       FROM messages outbound, latest_inbound
       WHERE outbound.contact_id = $1
         AND outbound.role = 'assistant'
         AND outbound.is_automated_follow_up = false
         AND NOT EXISTS (
           SELECT 1
           FROM outbound_message_evidence evidence
           WHERE evidence.message_id = outbound.id
             AND evidence.origin = 'system_fallback'
         )
         AND (outbound.created_at, outbound.id) >
             (latest_inbound.created_at, latest_inbound.id)
       ORDER BY outbound.created_at DESC, outbound.id DESC
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
     ), previous_follow_up AS (
       SELECT follow_up.created_at
       FROM messages follow_up, anchor
       WHERE follow_up.contact_id = $1
         AND follow_up.is_automated_follow_up = true
         AND follow_up.automated_follow_up_for_message_id = anchor.id
         AND follow_up.automated_follow_up_step = $5 - 1
       ORDER BY follow_up.created_at DESC, follow_up.id DESC
       LIMIT 1
     )
     INSERT INTO messages (
       contact_id,
       role,
       content,
       sent_by_username,
       media_url,
       media_key,
       media_mime_type,
       is_automated_follow_up,
       automated_follow_up_for_message_id,
       automated_follow_up_step,
       automated_follow_up_target_service,
       automated_follow_up_targeting_recorded,
       automated_follow_up_message_mode
     )
     SELECT $1, 'assistant', $3, 'Follow-up automation', $4, $14, $15, true, $2, $5, $6, true, $11
     FROM anchor, latest_inbound, progress, contacts c
     LEFT JOIN previous_follow_up ON true
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
           AND COALESCE(latest_lead.stage_type, 'open') = 'open'
           AND (
             COALESCE(latest_lead.appointment_status, 'none') IN ('reschedule', 'cancelled')
             OR (
               COALESCE(latest_lead.system_key, '') NOT IN ('appointment_set', 'visited')
               AND COALESCE(latest_lead.appointment_status, 'none') NOT IN ('set', 'visited')
             )
           )
         )
       )
       AND NOT EXISTS (
         SELECT 1
         FROM follow_up_ai_decisions decision
         WHERE decision.contact_id = c.id
           AND decision.trigger_message_id = anchor.id
           AND decision.action IN ('skip', 'human_review')
       )
       AND anchor.created_at >= $9::timestamptz
       AND CASE
             WHEN $12 = 'before_window_expiry'
               THEN ${beforeExpiryDueSql({inbound:"latest_inbound.created_at",previous:"previous_follow_up.created_at",step:"$5",offset:"$13::integer",gap:"($7::integer - $10::integer)",quietHours})}
             ELSE GREATEST(
               anchor.created_at + ($7::integer * interval '1 minute'),
               COALESCE(
                 previous_follow_up.created_at + (($7::integer - $10::integer) * interval '1 minute'),
                 anchor.created_at + ($7::integer * interval '1 minute')
               )
             )
           END <= now()
       AND CASE
             WHEN $12 = 'before_window_expiry'
               THEN ${beforeExpiryDueSql({inbound:"latest_inbound.created_at",previous:"previous_follow_up.created_at",step:"$5",offset:"$13::integer",gap:"($7::integer - $10::integer)",quietHours})}
             ELSE GREATEST(
               anchor.created_at + ($7::integer * interval '1 minute'),
               COALESCE(
                 previous_follow_up.created_at + (($7::integer - $10::integer) * interval '1 minute'),
                 anchor.created_at + ($7::integer * interval '1 minute')
               )
             )
           END <= latest_inbound.created_at + interval '23 hours 50 minutes'
       AND ${reserveFinalPricingWindow()
         ? "($5::integer <> 3 OR now() < latest_inbound.created_at + interval '23 hours 35 minutes')"
         : "TRUE"}
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
      numericPreviousDelay,
      normalizedMessageMode,
      normalizedTimingMode,
      numericBeforeWindowExpiryMinutes,
      normalizedMediaKey,
      normalizedMediaMimeType,
    ]
  );
  return result.rows[0] || null;
}

async function getAiFollowUpContext({ contactId, limit = 20 }) {
  const numericContactId = Number(contactId);
  const numericLimit = Math.max(1, Math.min(40, Number(limit) || 20));
  if (!Number.isSafeInteger(numericContactId) || numericContactId < 1) {
    return { messages: [], lead: null };
  }

  const messagesResult = await pool.query(
    `SELECT
       m.id,
       m.role,
       m.content,
       m.sent_by_username,
       m.is_automated_follow_up,
       m.automated_follow_up_step,
       m.automated_follow_up_for_message_id,
       m.created_at
     FROM messages m
     WHERE m.contact_id = $1
       AND m.role IN ('user', 'assistant')
       AND COALESCE(BTRIM(m.content), '') <> ''
       AND m.delivery_status IS DISTINCT FROM 'failed'
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $2`,
    [numericContactId, numericLimit]
  );

  const leadResult = await pool.query(
    `SELECT
       l.id AS lead_id,
       l.treatment_interest,
       l.branch_name,
       l.appointment_status,
       s.name AS stage_name
     FROM leads l
     LEFT JOIN pipeline_stages s ON s.id = l.stage_id
     WHERE l.contact_id = $1
     ORDER BY l.created_at DESC, l.id DESC
     LIMIT 1`,
    [numericContactId]
  );

  return {
    messages: messagesResult.rows.reverse(),
    lead: leadResult.rows[0] || null,
  };
}

async function recordAiDecisionIfStillEligible({
  contactId,
  triggerMessageId,
  stepIndex,
  action,
  reason = "",
  topic = "",
  delayMinutes,
  previousDelayMinutes = 0,
  timingMode = "after_reply",
  beforeWindowExpiryMinutes = 120,
  quietHours,
  triggerMode,
  activatedAt,
}) {
  const numericContactId = Number(contactId);
  const numericTriggerMessageId = Number(triggerMessageId);
  const numericStep = Number(stepIndex);
  const numericDelay = Number(delayMinutes);
  const numericPreviousDelay = Number(previousDelayMinutes);
  const numericBeforeWindowExpiryMinutes = Number(beforeWindowExpiryMinutes);
  const normalizedTimingMode =
    timingMode === "before_window_expiry"
      ? "before_window_expiry"
      : "after_reply";
  const normalizedAction = String(action || "").trim().toLowerCase();
  const normalizedReason = String(reason || "").slice(0, 1000);
  const normalizedTopic = String(topic || "").slice(0, 500);

  if (
    !Number.isSafeInteger(numericContactId) ||
    numericContactId < 1 ||
    !Number.isSafeInteger(numericTriggerMessageId) ||
    numericTriggerMessageId < 1 ||
    !Number.isInteger(numericStep) ||
    numericStep < 1 ||
    numericStep > MAX_FOLLOW_UP_STEPS ||
    !["skip", "human_review"].includes(normalizedAction) ||
    !Number.isInteger(numericDelay) ||
    numericDelay < 5 ||
    numericDelay > 23 * 60 ||
    !Number.isInteger(numericPreviousDelay) ||
    numericPreviousDelay < 0 ||
    numericPreviousDelay >= numericDelay ||
    (numericStep === 1 && numericPreviousDelay !== 0) ||
    (numericStep > 1 && numericPreviousDelay < 5) ||
    !Number.isInteger(numericBeforeWindowExpiryMinutes) ||
    numericBeforeWindowExpiryMinutes < 60 ||
    numericBeforeWindowExpiryMinutes > 360 ||
    (normalizedTimingMode === "before_window_expiry" &&
      numericDelay !== 24 * 60 - numericBeforeWindowExpiryMinutes) ||
    !["all", "staff"].includes(triggerMode) ||
    typeof activatedAt !== "string" ||
    Number.isNaN(Date.parse(activatedAt))
  ) {
    throw new TypeError("Invalid AI follow-up decision or sequence state.");
  }

  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     ), latest_inbound AS (
       SELECT inbound.id, inbound.created_at
       FROM messages inbound, conversation_lock
       WHERE inbound.contact_id = $1
         AND inbound.role = 'user'
       ORDER BY inbound.created_at DESC, inbound.id DESC
       LIMIT 1
     ), anchor AS (
       SELECT
         outbound.id,
         outbound.sent_by_username,
         outbound.created_at,
         outbound.delivery_status
       FROM messages outbound, latest_inbound
       WHERE outbound.contact_id = $1
         AND outbound.role = 'assistant'
         AND outbound.is_automated_follow_up = false
         AND NOT EXISTS (
           SELECT 1
           FROM outbound_message_evidence evidence
           WHERE evidence.message_id = outbound.id
             AND evidence.origin = 'system_fallback'
         )
         AND (outbound.created_at, outbound.id) >
             (latest_inbound.created_at, latest_inbound.id)
       ORDER BY outbound.created_at DESC, outbound.id DESC
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
     ), previous_follow_up AS (
       SELECT follow_up.created_at
       FROM messages follow_up, anchor
       WHERE follow_up.contact_id = $1
         AND follow_up.is_automated_follow_up = true
         AND follow_up.automated_follow_up_for_message_id = anchor.id
         AND follow_up.automated_follow_up_step = $3 - 1
       ORDER BY follow_up.created_at DESC, follow_up.id DESC
       LIMIT 1
     ), latest_lead AS (
       SELECT
         l.id,
         l.is_closed,
         l.appointment_status,
         s.stage_type,
         s.system_key
       FROM leads l
       LEFT JOIN pipeline_stages s ON s.id = l.stage_id
       WHERE l.contact_id = $1
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT 1
     ), inserted_decision AS (
       INSERT INTO follow_up_ai_decisions (
         contact_id,
         trigger_message_id,
         follow_up_step,
         action,
         reason,
         topic
       )
       SELECT
         $1,
         $2,
         $3,
         $4,
         NULLIF(BTRIM($5), ''),
         NULLIF(BTRIM($6), '')
       FROM contacts c, latest_inbound, anchor, progress
       LEFT JOIN previous_follow_up ON true
       LEFT JOIN latest_lead ON true
       WHERE c.id = $1
         AND c.needs_attention = false
         AND anchor.id = $2
         AND anchor.delivery_status IS DISTINCT FROM 'failed'
         AND (
           latest_lead.id IS NULL
           OR (
             latest_lead.is_closed = false
             AND COALESCE(latest_lead.stage_type, 'open') = 'open'
             AND (
               COALESCE(latest_lead.appointment_status, 'none') IN ('reschedule', 'cancelled')
               OR (
                 COALESCE(latest_lead.system_key, '') NOT IN ('appointment_set', 'visited')
                 AND COALESCE(latest_lead.appointment_status, 'none') NOT IN ('set', 'visited')
               )
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM follow_up_ai_decisions existing
           WHERE existing.contact_id = c.id
             AND existing.trigger_message_id = anchor.id
             AND existing.action IN ('skip', 'human_review')
         )
         AND anchor.created_at >= $9::timestamptz
         AND CASE
               WHEN $11 = 'before_window_expiry'
               THEN ${beforeExpiryDueSql({inbound:"latest_inbound.created_at",previous:"previous_follow_up.created_at",step:"$3",offset:"$12::integer",gap:"($7::integer - $10::integer)",quietHours})}
             ELSE GREATEST(
                 anchor.created_at + ($7::integer * interval '1 minute'),
                 COALESCE(
                   previous_follow_up.created_at + (($7::integer - $10::integer) * interval '1 minute'),
                   anchor.created_at + ($7::integer * interval '1 minute')
                 )
               )
             END <= now()
         AND CASE
               WHEN $11 = 'before_window_expiry'
               THEN ${beforeExpiryDueSql({inbound:"latest_inbound.created_at",previous:"previous_follow_up.created_at",step:"$3",offset:"$12::integer",gap:"($7::integer - $10::integer)",quietHours})}
             ELSE GREATEST(
                 anchor.created_at + ($7::integer * interval '1 minute'),
                 COALESCE(
                   previous_follow_up.created_at + (($7::integer - $10::integer) * interval '1 minute'),
                   anchor.created_at + ($7::integer * interval '1 minute')
                 )
               )
             END <= latest_inbound.created_at + interval '23 hours 50 minutes'
       AND ${reserveFinalPricingWindow()
         ? "($3::integer <> 3 OR now() < latest_inbound.created_at + interval '23 hours 35 minutes')"
         : "TRUE"}
         AND ($8 = 'all' OR anchor.sent_by_username IS NOT NULL)
         AND COALESCE(progress.max_step, 0) + 1 = $3
         AND COALESCE(progress.has_blocking_claim, false) = false
       ON CONFLICT (trigger_message_id, follow_up_step) DO NOTHING
       RETURNING *
     ), attention_update AS (
       UPDATE contacts c
       SET needs_attention = true,
           attention_reason = LEFT(
             'AI follow-up requested human review: ' ||
             COALESCE(
               NULLIF(BTRIM(inserted_decision.reason), ''),
               'Staff should review this conversation before any follow-up.'
             ),
             1000
           ),
           updated_at = now()
       FROM inserted_decision
       WHERE inserted_decision.action = 'human_review'
         AND c.id = inserted_decision.contact_id
       RETURNING c.id
     )
     SELECT inserted_decision.*
     FROM inserted_decision
     LEFT JOIN attention_update ON true`,
    [
      numericContactId,
      numericTriggerMessageId,
      numericStep,
      normalizedAction,
      normalizedReason,
      normalizedTopic,
      numericDelay,
      triggerMode,
      activatedAt,
      numericPreviousDelay,
      normalizedTimingMode,
      numericBeforeWindowExpiryMinutes,
    ]
  );

  return result.rows[0] || null;
}

async function isClaimStillEligible({ messageId, contactId }) {
  const numericMessageId = Number(messageId);
  const numericContactId = Number(contactId);
  if (
    !Number.isInteger(numericMessageId) ||
    numericMessageId <= 0 ||
    !Number.isInteger(numericContactId) ||
    numericContactId <= 0
  ) {
    return false;
  }

  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     ), claim AS (
       SELECT
         m.id,
         m.contact_id,
         m.created_at,
         m.delivery_status,
         m.whatsapp_message_id,
         m.automated_follow_up_for_message_id AS trigger_message_id
       FROM messages m, conversation_lock
       WHERE m.id = $2
         AND m.contact_id = $1
         AND m.role = 'assistant'
         AND m.is_automated_follow_up = true
         AND m.automated_follow_up_for_message_id IS NOT NULL
       LIMIT 1
     )
     SELECT EXISTS (
       SELECT 1
       FROM claim
       JOIN contacts c ON c.id = claim.contact_id
       JOIN messages anchor
         ON anchor.id = claim.trigger_message_id
        AND anchor.contact_id = claim.contact_id
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
       WHERE c.needs_attention = false
         AND NOT EXISTS (
           SELECT 1
           FROM follow_up_ai_decisions decision
           WHERE decision.contact_id = c.id
             AND decision.trigger_message_id = anchor.id
             AND decision.action IN ('skip', 'human_review')
         )
         AND claim.delivery_status IS NULL
         AND claim.whatsapp_message_id IS NULL
         AND (
           latest_lead.id IS NULL
           OR (
             latest_lead.is_closed = false
             AND COALESCE(latest_lead.stage_type, 'open') = 'open'
             AND (
               COALESCE(latest_lead.appointment_status, 'none') IN ('reschedule', 'cancelled')
               OR (
                 COALESCE(latest_lead.system_key, '') NOT IN ('appointment_set', 'visited')
                 AND COALESCE(latest_lead.appointment_status, 'none') NOT IN ('set', 'visited')
               )
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1
           FROM messages newer
           WHERE newer.contact_id = claim.contact_id
             AND (newer.created_at, newer.id) > (claim.created_at, claim.id)
             AND (
               newer.role = 'user'
               OR (
                 newer.role = 'assistant'
                 AND newer.is_automated_follow_up = false
               )
             )
         )
     ) AS eligible`,
    [numericContactId, numericMessageId]
  );

  return result.rows[0]?.eligible === true;
}

async function discardUnsentClaim({ messageId, contactId }) {
  const numericMessageId = Number(messageId);
  const numericContactId = Number(contactId);
  if (
    !Number.isInteger(numericMessageId) ||
    numericMessageId <= 0 ||
    !Number.isInteger(numericContactId) ||
    numericContactId <= 0
  ) {
    return null;
  }

  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     )
     DELETE FROM messages
     WHERE id = $2
       AND contact_id = $1
       AND role = 'assistant'
       AND is_automated_follow_up = true
       AND automated_follow_up_for_message_id IS NOT NULL
       AND delivery_status IS NULL
       AND whatsapp_message_id IS NULL
       AND EXISTS (SELECT 1 FROM conversation_lock)
     RETURNING ${FOLLOW_UP_MESSAGE_COLUMNS}`,
    [numericContactId, numericMessageId]
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

async function saveSocialVideoCompanion({
  contactId,
  mediaKey,
  mediaMimeType = "video/mp4",
}) {
  const normalizedKey = String(mediaKey || "").trim();
  if (!normalizedKey || mediaMimeType !== "video/mp4") {
    throw new TypeError("A durable MP4 media key is required.");
  }
  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     )
     INSERT INTO messages (
       contact_id,
       role,
       content,
       sent_by_username,
       media_key,
       media_mime_type,
       is_automated_follow_up
     )
     SELECT $1, 'assistant', '', 'Follow-up automation', $2, $3, true
     FROM conversation_lock
     RETURNING ${FOLLOW_UP_MESSAGE_COLUMNS}`,
    [contactId, normalizedKey, mediaMimeType]
  );
  return result.rows[0] || null;
}

async function discardUnsentSocialVideoCompanion({ messageId, contactId }) {
  const numericMessageId = Number(messageId);
  const numericContactId = Number(contactId);
  if (
    !Number.isInteger(numericMessageId) ||
    numericMessageId <= 0 ||
    !Number.isInteger(numericContactId) ||
    numericContactId <= 0
  ) {
    return null;
  }

  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     )
     DELETE FROM messages
     WHERE id = $2
       AND contact_id = $1
       AND role = 'assistant'
       AND is_automated_follow_up = true
       AND automated_follow_up_for_message_id IS NULL
       AND content = ''
       AND media_key IS NOT NULL
       AND media_mime_type = 'video/mp4'
       AND delivery_status IS NULL
       AND whatsapp_message_id IS NULL
       AND EXISTS (SELECT 1 FROM conversation_lock)
     RETURNING ${FOLLOW_UP_MESSAGE_COLUMNS}`,
    [numericContactId, numericMessageId]
  );

  return result.rows[0] || null;
}

async function discardUnsentSocialImageCompanion({ messageId, contactId }) {
  const numericMessageId = Number(messageId);
  const numericContactId = Number(contactId);
  if (
    !Number.isInteger(numericMessageId) ||
    numericMessageId <= 0 ||
    !Number.isInteger(numericContactId) ||
    numericContactId <= 0
  ) {
    return null;
  }

  const result = await pool.query(
    `WITH conversation_lock AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     )
     DELETE FROM messages
     WHERE id = $2
       AND contact_id = $1
       AND role = 'assistant'
       AND is_automated_follow_up = true
       AND automated_follow_up_for_message_id IS NULL
       AND content = ''
       AND media_url IS NOT NULL
       AND delivery_status IS NULL
       AND whatsapp_message_id IS NULL
       AND EXISTS (SELECT 1 FROM conversation_lock)
     RETURNING ${FOLLOW_UP_MESSAGE_COLUMNS}`,
    [numericContactId, numericMessageId]
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
  getAiFollowUpContext,
  recordAiDecisionIfStillEligible,
  saveIfStillEligible,
  isClaimStillEligible,
  discardUnsentClaim,
  saveSocialImageCompanion,
  saveSocialVideoCompanion,
  discardUnsentSocialImageCompanion,
  discardUnsentSocialVideoCompanion,
  markStaleClaimsUnconfirmed,
};
