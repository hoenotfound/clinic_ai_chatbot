const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");

const MAX_FOLLOW_UP_STEPS = 3;
const DEFAULT_STALE_AFTER_SECONDS = 120;

function validActivation(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

async function claimIfStillEligible({
  contactId,
  triggerMessageId,
  stepIndex,
  leaseToken,
  delayMinutes,
  previousDelayMinutes = 0,
  triggerMode,
  activatedAt,
  staleAfterSeconds = DEFAULT_STALE_AFTER_SECONDS,
}) {
  const numericContactId = Number(contactId);
  const numericTriggerMessageId = Number(triggerMessageId);
  const numericStep = Number(stepIndex);
  const numericDelay = Number(delayMinutes);
  const numericPreviousDelay = Number(previousDelayMinutes);
  const numericStaleSeconds = Math.max(
    30,
    Math.min(600, Number(staleAfterSeconds) || DEFAULT_STALE_AFTER_SECONDS)
  );
  const normalizedLeaseToken = String(leaseToken || "").trim();

  if (
    !Number.isSafeInteger(numericContactId) ||
    numericContactId < 1 ||
    !Number.isSafeInteger(numericTriggerMessageId) ||
    numericTriggerMessageId < 1 ||
    !Number.isInteger(numericStep) ||
    numericStep < 1 ||
    numericStep > MAX_FOLLOW_UP_STEPS ||
    !normalizedLeaseToken ||
    !Number.isInteger(numericDelay) ||
    numericDelay < 5 ||
    numericDelay > 23 * 60 ||
    !Number.isInteger(numericPreviousDelay) ||
    numericPreviousDelay < 0 ||
    numericPreviousDelay >= numericDelay ||
    (numericStep === 1 && numericPreviousDelay !== 0) ||
    (numericStep > 1 && numericPreviousDelay < 5) ||
    !["all", "staff"].includes(triggerMode) ||
    !validActivation(activatedAt)
  ) {
    throw new TypeError("Invalid AI follow-up generation lease state.");
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
       SELECT outbound.id, outbound.sent_by_username, outbound.created_at, outbound.delivery_status
       FROM messages outbound, latest_inbound
       WHERE outbound.contact_id = $1
         AND outbound.role = 'assistant'
         AND outbound.is_automated_follow_up = false
         AND (outbound.created_at, outbound.id) > (latest_inbound.created_at, latest_inbound.id)
       ORDER BY outbound.created_at DESC, outbound.id DESC
       LIMIT 1
     ), progress AS (
       SELECT
         MAX(follow_up.automated_follow_up_step) AS max_step,
         BOOL_OR(
           follow_up.delivery_status IN ('failed', 'unknown')
           OR (follow_up.delivery_status IS NULL AND follow_up.whatsapp_message_id IS NULL)
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
       SELECT l.id, l.is_closed, l.appointment_status, s.stage_type, s.system_key
       FROM leads l
       LEFT JOIN pipeline_stages s ON s.id = l.stage_id
       WHERE l.contact_id = $1
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT 1
     )
     INSERT INTO follow_up_ai_generation_claims (
       contact_id, trigger_message_id, follow_up_step, lease_token, claimed_at
     )
     SELECT $1, $2, $3, $4, now()
     FROM contacts c, latest_inbound, anchor, progress
     LEFT JOIN previous_follow_up ON true
     LEFT JOIN latest_lead ON true
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
       AND anchor.created_at >= $8::timestamptz
       AND GREATEST(
             anchor.created_at + ($5::integer * interval '1 minute'),
             COALESCE(
               previous_follow_up.created_at + (($5::integer - $6::integer) * interval '1 minute'),
               anchor.created_at + ($5::integer * interval '1 minute')
             )
           ) <= now()
       AND GREATEST(
             anchor.created_at + ($5::integer * interval '1 minute'),
             COALESCE(
               previous_follow_up.created_at + (($5::integer - $6::integer) * interval '1 minute'),
               anchor.created_at + ($5::integer * interval '1 minute')
             )
           ) <= latest_inbound.created_at + interval '23 hours 50 minutes'
       AND ($7 = 'all' OR anchor.sent_by_username IS NOT NULL)
       AND COALESCE(progress.max_step, 0) + 1 = $3
       AND COALESCE(progress.has_blocking_claim, false) = false
     ON CONFLICT (trigger_message_id, follow_up_step) DO UPDATE
       SET contact_id = EXCLUDED.contact_id,
           lease_token = EXCLUDED.lease_token,
           claimed_at = now()
       WHERE follow_up_ai_generation_claims.claimed_at
             <= now() - ($9::integer * interval '1 second')
     RETURNING *`,
    [
      numericContactId,
      numericTriggerMessageId,
      numericStep,
      normalizedLeaseToken,
      numericDelay,
      numericPreviousDelay,
      triggerMode,
      activatedAt,
      numericStaleSeconds,
    ]
  );

  return result.rows[0] || null;
}

async function release({
  contactId,
  triggerMessageId,
  stepIndex,
  leaseToken,
}) {
  const numericContactId = Number(contactId);
  const numericTriggerMessageId = Number(triggerMessageId);
  const numericStep = Number(stepIndex);
  const normalizedLeaseToken = String(leaseToken || "").trim();

  if (
    !Number.isSafeInteger(numericContactId) ||
    numericContactId < 1 ||
    !Number.isSafeInteger(numericTriggerMessageId) ||
    numericTriggerMessageId < 1 ||
    !Number.isInteger(numericStep) ||
    numericStep < 1 ||
    numericStep > MAX_FOLLOW_UP_STEPS ||
    !normalizedLeaseToken
  ) {
    return null;
  }

  const result = await pool.query(
    `DELETE FROM follow_up_ai_generation_claims
     WHERE contact_id = $1
       AND trigger_message_id = $2
       AND follow_up_step = $3
       AND lease_token = $4
     RETURNING id`,
    [
      numericContactId,
      numericTriggerMessageId,
      numericStep,
      normalizedLeaseToken,
    ]
  );
  return result.rows[0] || null;
}

module.exports = {
  DEFAULT_STALE_AFTER_SECONDS,
  claimIfStillEligible,
  release,
};
