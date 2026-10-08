const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");
const { beforeExpiryDueSql } = require("../utils/followUpAdaptiveTiming");

const MINUTES_AFTER_REPLY = 600;
const MINUTES_AFTER_SECOND = 120;
const MINUTES_BEFORE_FINAL = 120;
const MINUTES_AFTER_FINAL = 5;

function afterFinalMode(settings) {
  return settings?.pricingReminder?.mode === "after_final";
}

function finalDueSql(settings) {
  const step = settings?.steps?.[2];
  const previous = settings?.steps?.[1];
  if (!step || !previous) throw new TypeError("Pricing reminder requires three follow-up steps.");
  const delay = Number(step.delayMinutes);
  const prior = Number(previous.delayMinutes);
  const offset = Number(step.beforeWindowExpiryMinutes);
  if (![delay, prior, offset].every(Number.isInteger) ||
      delay <= prior || delay > 1380 || prior < 5 || offset < 60 || offset > 360) {
    throw new TypeError("Invalid final follow-up schedule.");
  }
  if (step.timingMode === "before_window_expiry") {
    return beforeExpiryDueSql({
      inbound: "inbound.created_at",
      previous: "second.created_at",
      step: "3",
      offset: String(offset),
      gap: String(delay - prior),
      quietHours: settings.quietHours,
    });
  }
  return `GREATEST(anchor.created_at + interval '${delay} minutes',
    second.created_at + interval '${delay - prior} minutes')`;
}


// The pricing reminder is deliberately outside the 1..3 follow-up sequence:
// it uses its own anchor, leaving progress.max_step and Follow-up 3 unchanged.
const eligibleSql = (settings) => {
  const afterFinal = afterFinalMode(settings);
  const thirdDueSql = afterFinal ? "third.created_at" : finalDueSql(settings);
  return `
WITH eligible AS (
 SELECT
   c.id AS contact_id, c.whatsapp_number, anchor.id AS anchor_id,
   anchor.created_at AS anchor_at, inbound.id AS inbound_id,
   inbound.created_at AS inbound_at, second.created_at AS second_at,
   ${thirdDueSql} AS final_due_at,
   third.id AS final_message_id,
   lead.treatment_interest,
   ${afterFinal ? `third.created_at + interval '${MINUTES_AFTER_FINAL} minutes'` : `GREATEST(
     anchor.created_at + interval '${MINUTES_AFTER_REPLY} minutes',
     second.created_at + interval '${MINUTES_AFTER_SECOND} minutes'
   )`} AS due_at,
   (SELECT COALESCE(jsonb_agg(user_messages.content ORDER BY user_messages.created_at DESC, user_messages.id DESC), '[]'::jsonb)
      FROM (SELECT id, content, created_at FROM messages
            WHERE contact_id = c.id AND role = 'user'
              AND created_at >= inbound.created_at - interval '24 hours'
            ORDER BY created_at DESC, id DESC LIMIT 15) user_messages
   ) AS recent_customer_messages,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object(
       'media_url', media.media_url, 'content', media.content,
       'delivery_status', media.delivery_status, 'whatsapp_message_id', media.whatsapp_message_id
   )), '[]'::jsonb)
    FROM (SELECT media_url, content, delivery_status, whatsapp_message_id FROM messages
          WHERE contact_id = c.id AND role = 'assistant'
            AND media_url IS NOT NULL AND media_url <> ''
          ORDER BY created_at DESC, id DESC LIMIT 150) media
   ) AS sent_media
 FROM contacts c
 JOIN LATERAL (
   SELECT id, created_at FROM messages
   WHERE contact_id = c.id AND role = 'user'
   ORDER BY created_at DESC, id DESC LIMIT 1
 ) inbound ON true
 JOIN LATERAL (
   SELECT id, created_at, sent_by_username, delivery_status
   FROM messages
   WHERE contact_id = c.id AND role = 'assistant'
     AND is_automated_follow_up = false
     AND NOT EXISTS (SELECT 1 FROM outbound_message_evidence e
       WHERE e.message_id = messages.id AND e.origin = 'system_fallback')
     AND (created_at, id) > (inbound.created_at, inbound.id)
   ORDER BY created_at DESC, id DESC LIMIT 1
 ) anchor ON true
 JOIN LATERAL (
   SELECT id, created_at FROM messages
   WHERE contact_id = c.id AND is_automated_follow_up = true
     AND automated_follow_up_for_message_id = anchor.id
     AND automated_follow_up_step = 2
     AND (delivery_status IN ('sent', 'delivered', 'read')
       OR (delivery_status = 'pending' AND whatsapp_message_id IS NOT NULL))
   ORDER BY created_at DESC, id DESC LIMIT 1
 ) second ON true
 LEFT JOIN LATERAL (
   SELECT id, created_at, delivery_status, whatsapp_message_id FROM messages
   WHERE contact_id = c.id AND is_automated_follow_up = true
     AND automated_follow_up_for_message_id = anchor.id
     AND automated_follow_up_step = 3 LIMIT 1
 ) third ON true
 LEFT JOIN LATERAL (
   SELECT id FROM messages WHERE pricing_reminder_anchor_id = anchor.id LIMIT 1
 ) pricing ON true
 LEFT JOIN LATERAL (
   SELECT id FROM pricing_reminder_decisions WHERE anchor_id = anchor.id LIMIT 1
 ) decision ON true
 LEFT JOIN LATERAL (
   SELECT l.treatment_interest, l.is_closed, l.appointment_status,
          s.stage_type, s.system_key
   FROM leads l LEFT JOIN pipeline_stages s ON s.id = l.stage_id
   WHERE l.contact_id = c.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1
 ) lead ON true
 WHERE c.channel = 'whatsapp' AND c.whatsapp_number IS NOT NULL
   AND c.needs_attention = false
   AND COALESCE(c.mode,'ai') <> 'human'
   AND c.whatsapp_opt_out_at IS NULL
   AND c.whatsapp_marketing_opt_out_at IS NULL
   AND anchor.delivery_status IS DISTINCT FROM 'failed'
   AND anchor.created_at >= $1::timestamptz
   AND ($2::text = 'all' OR anchor.sent_by_username IS NOT NULL)
   AND inbound.created_at > now() - interval '23 hours 50 minutes'
   AND ${afterFinal
     ? "(third.id IS NOT NULL AND (third.delivery_status IN ('sent','delivered','read') OR (third.delivery_status='pending' AND third.whatsapp_message_id IS NOT NULL)))"
     : "third.id IS NULL"} AND pricing.id IS NULL AND decision.id IS NULL
   AND (lead.treatment_interest IS NOT NULL OR EXISTS(
     SELECT 1 FROM messages u WHERE u.contact_id = c.id AND u.role='user'
   ))
   AND (lead.is_closed IS NULL OR (
      lead.is_closed = false AND COALESCE(lead.stage_type, 'open')='open'
      AND (COALESCE(lead.appointment_status,'none') IN ('reschedule','cancelled')
        OR (COALESCE(lead.system_key,'') NOT IN ('appointment_set','visited')
          AND COALESCE(lead.appointment_status,'none') NOT IN ('set','visited')))
   ))
   AND NOT EXISTS (
     SELECT 1 FROM follow_up_ai_decisions d
     WHERE d.contact_id=c.id AND d.trigger_message_id=anchor.id
       AND d.action IN ('skip','human_review')
   )
)
SELECT * FROM eligible
WHERE due_at <= inbound_at + interval '23 hours 50 minutes'
ORDER BY due_at ASC LIMIT 200
`;
};

async function listEligible({ activatedAt, triggerMode, settings }) {
  const result = await pool.query(eligibleSql(settings), [activatedAt, triggerMode]);
  return result.rows;
}

async function claim({ candidate, offer, activatedAt, triggerMode, settings }) {
  const finalDue = new Date(candidate.final_due_at);
  if (Number.isNaN(finalDue.getTime())) return null;
  const afterFinal = afterFinalMode(settings);
  // Advisory locking, a unique index, and a final outbound/media check guard
  // simultaneous workers and races with AI/staff price sends.
  const result = await pool.query(
    `WITH guard AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     ), inbound AS (
       SELECT id, created_at FROM messages, guard
       WHERE contact_id=$1 AND role='user'
       ORDER BY created_at DESC, id DESC LIMIT 1
     ), anchor AS (
       SELECT id, created_at, sent_by_username FROM messages
       WHERE contact_id=$1 AND role='assistant' AND is_automated_follow_up=false
         AND delivery_status IS DISTINCT FROM 'failed'
         AND (created_at,id) > ((SELECT created_at FROM inbound),(SELECT id FROM inbound))
         AND NOT EXISTS (SELECT 1 FROM outbound_message_evidence e
           WHERE e.message_id=messages.id AND e.origin='system_fallback')
       ORDER BY created_at DESC,id DESC LIMIT 1
     ), second AS (
       SELECT created_at FROM messages
       WHERE contact_id=$1 AND is_automated_follow_up=true
         AND automated_follow_up_for_message_id=$2
         AND automated_follow_up_step=${afterFinal ? 3 : 2}
         AND (delivery_status IN ('sent','delivered','read')
           OR (delivery_status = 'pending' AND whatsapp_message_id IS NOT NULL))
       LIMIT 1
     )
     INSERT INTO messages (
       contact_id, role, content, sent_by_username, media_url,
       is_automated_follow_up, automated_follow_up_step, pricing_reminder_anchor_id,
       automated_follow_up_target_service, automated_follow_up_targeting_recorded,
       automated_follow_up_message_mode
     )
     SELECT $1, 'assistant', $3, 'Follow-up automation', $4,
       true, 4, $2, $5, true, 'fixed'
     FROM inbound, anchor, second
     JOIN contacts c ON c.id=$1
     LEFT JOIN LATERAL (
       SELECT l.is_closed, l.appointment_status, s.stage_type,s.system_key
       FROM leads l LEFT JOIN pipeline_stages s ON s.id=l.stage_id
       WHERE l.contact_id=c.id ORDER BY l.created_at DESC,l.id DESC LIMIT 1
     ) lead ON true
     WHERE inbound.id=$6 AND anchor.id=$2
       AND c.channel='whatsapp' AND c.whatsapp_number IS NOT NULL
       AND c.needs_attention=false
         AND COALESCE(c.mode,'ai') <> 'human'
         AND c.whatsapp_opt_out_at IS NULL
         AND c.whatsapp_marketing_opt_out_at IS NULL
       AND anchor.created_at >= $7::timestamptz
       AND ($8='all' OR anchor.sent_by_username IS NOT NULL)
       AND now() < inbound.created_at + interval '23 hours 50 minutes'
       AND ${afterFinal
         ? `now() >= $10::timestamptz + interval '${MINUTES_AFTER_FINAL} minutes'`
         : `now() + interval '${MINUTES_BEFORE_FINAL} minutes' <= $10::timestamptz
       AND now() <= $10::timestamptz
       AND now() >= GREATEST(
         anchor.created_at + interval '${MINUTES_AFTER_REPLY} minutes',
         second.created_at + interval '${MINUTES_AFTER_SECOND} minutes'
       )`}
       AND (lead.is_closed IS NULL OR (
          lead.is_closed=false AND COALESCE(lead.stage_type,'open')='open'
          AND (COALESCE(lead.appointment_status,'none') IN ('reschedule','cancelled')
            OR (COALESCE(lead.system_key,'') NOT IN ('appointment_set','visited')
              AND COALESCE(lead.appointment_status,'none') NOT IN ('set','visited')))
       ))
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.pricing_reminder_anchor_id=$2)
       AND NOT EXISTS (SELECT 1 FROM pricing_reminder_decisions d WHERE d.anchor_id=$2)
       AND COALESCE((SELECT l.treatment_interest FROM leads l
         WHERE l.contact_id=$1 ORDER BY l.created_at DESC,l.id DESC LIMIT 1),'')
          = COALESCE($11::text,'')
       AND ${afterFinal
         ? `EXISTS (SELECT 1 FROM messages m WHERE m.contact_id=$1
             AND m.is_automated_follow_up=true
             AND m.automated_follow_up_for_message_id=$2
             AND m.automated_follow_up_step=3
             AND m.id=$12::integer
             AND now() >= m.created_at + interval '${MINUTES_AFTER_FINAL} minutes'
             AND (m.delivery_status IN ('sent','delivered','read')
               OR (m.delivery_status='pending' AND m.whatsapp_message_id IS NOT NULL)))`
         : `NOT EXISTS (SELECT 1 FROM messages m
         WHERE m.contact_id=$1 AND m.is_automated_follow_up=true
           AND m.automated_follow_up_for_message_id=$2
           AND m.automated_follow_up_step=3)`}
       AND NOT EXISTS (SELECT 1 FROM follow_up_ai_decisions d
         WHERE d.contact_id=$1 AND d.trigger_message_id=$2
           AND d.action IN ('skip','human_review'))
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.contact_id=$1
         AND m.role='assistant' AND m.media_url IS NOT NULL
         AND m.content IS NOT NULL AND m.content <> ''
         AND split_part(regexp_replace(m.media_url, '^https?://[^/]+', ''), '?',1)=ANY($9::text[]))
     ON CONFLICT DO NOTHING
     RETURNING id,contact_id,content,media_url,delivery_status`,
    [candidate.contact_id, candidate.anchor_id, offer.caption, offer.imageUrl,
      offer.serviceName, candidate.inbound_id, activatedAt, triggerMode, offer.identities,
      candidate.final_due_at, candidate.treatment_interest,
      ...(afterFinal ? [candidate.final_message_id || null] : [])]
  );
  return result.rows[0] || null;
}

async function isClaimStillEligible({
  messageId, contactId, anchorId, inboundId,
  imageIdentities = [], treatmentInterest = null, finalDueAt, whatsappNumber,
  afterFinal = false, finalMessageId = null,
}) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM messages m
       JOIN contacts c ON c.id=m.contact_id
       WHERE m.id=$1 AND m.contact_id=$2 AND m.pricing_reminder_anchor_id=$3
         AND m.delivery_status IS NULL AND m.whatsapp_message_id IS NULL
         AND c.needs_attention=false
         AND COALESCE(c.mode,'ai') <> 'human'
         AND c.whatsapp_opt_out_at IS NULL
         AND c.whatsapp_marketing_opt_out_at IS NULL AND c.channel='whatsapp'
         AND c.whatsapp_number = $8::text
         AND ${afterFinal
           ? `now() >= $7::timestamptz + interval '${MINUTES_AFTER_FINAL} minutes'`
           : `now() + interval '${MINUTES_BEFORE_FINAL} minutes' <= $7::timestamptz`}
         AND COALESCE((SELECT l.treatment_interest FROM leads l
            WHERE l.contact_id=$2 ORDER BY l.created_at DESC,l.id DESC LIMIT 1),'')
             = COALESCE($6::text,'')
         AND (SELECT id FROM messages WHERE contact_id=$2 AND role='user'
              ORDER BY created_at DESC,id DESC LIMIT 1)=$4
         AND now() < (SELECT created_at FROM messages WHERE id=$4)+interval '23 hours 50 minutes'
         AND (SELECT id FROM messages
              WHERE contact_id=$2 AND role='assistant' AND is_automated_follow_up=false
                AND delivery_status IS DISTINCT FROM 'failed'
                AND NOT EXISTS(SELECT 1 FROM outbound_message_evidence e
                  WHERE e.message_id=messages.id AND e.origin='system_fallback')
                AND (created_at,id) > (SELECT created_at,id FROM messages WHERE id=$4)
              ORDER BY created_at DESC,id DESC LIMIT 1)=$3
         AND ${afterFinal
           ? `EXISTS (SELECT 1 FROM messages f WHERE f.contact_id=$2
             AND f.automated_follow_up_for_message_id=$3
             AND f.automated_follow_up_step=3 AND f.id=$9::integer
             AND now() >= f.created_at + interval '${MINUTES_AFTER_FINAL} minutes'
             AND (f.delivery_status IN ('sent','delivered','read')
               OR (f.delivery_status='pending' AND f.whatsapp_message_id IS NOT NULL)))`
           : `NOT EXISTS(SELECT 1 FROM messages f
           WHERE f.automated_follow_up_for_message_id=$3 AND f.automated_follow_up_step=3)`}
         AND NOT EXISTS(SELECT 1 FROM pricing_reminder_decisions d
           WHERE d.anchor_id=$3)
         AND NOT EXISTS(SELECT 1 FROM follow_up_ai_decisions d
           WHERE d.contact_id=$2 AND d.trigger_message_id=$3 AND d.action IN ('skip','human_review'))
         AND NOT EXISTS (
           SELECT 1 FROM (
             SELECT l.is_closed,l.appointment_status,s.stage_type,s.system_key
             FROM leads l LEFT JOIN pipeline_stages s ON s.id=l.stage_id
             WHERE l.contact_id=$2 ORDER BY l.created_at DESC,l.id DESC LIMIT 1
           ) lead
           WHERE lead.is_closed=true OR COALESCE(lead.stage_type,'open')<>'open'
             OR (COALESCE(lead.appointment_status,'none') NOT IN ('reschedule','cancelled')
               AND (COALESCE(lead.system_key,'') IN ('appointment_set','visited')
                 OR COALESCE(lead.appointment_status,'none') IN ('set','visited')))
         )
         AND NOT EXISTS (SELECT 1 FROM messages prior
           WHERE prior.contact_id=$2 AND prior.id<>$1 AND prior.role='assistant'
             AND prior.media_url IS NOT NULL AND prior.content IS NOT NULL
             AND prior.content <> ''
             AND split_part(regexp_replace(prior.media_url, '^https?://[^/]+', ''), '?',1)
               =ANY($5::text[]))
     ) AS eligible`, [messageId, contactId, anchorId, inboundId,
       imageIdentities, treatmentInterest, finalDueAt, whatsappNumber,
       ...(afterFinal ? [finalMessageId] : [])]);
  return result.rows[0]?.eligible === true;
}

async function recordDecision({ candidate, reason }) {
  const allowed = new Set([
    "already_sent", "delivery_review", "ambiguous_service",
    "ambiguous_package", "missing_promotion", "insufficient_window",
    "no_pricing_interest",
  ]);
  if (!allowed.has(reason)) throw new TypeError("Unsupported pricing decision.");
  const result = await pool.query(
    `WITH guard AS MATERIALIZED (
       SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)
     )
     INSERT INTO pricing_reminder_decisions(contact_id, anchor_id, reason)
     SELECT $1, $2, $3
     FROM guard
     WHERE EXISTS (SELECT 1 FROM contacts WHERE id=$1)
       AND EXISTS (SELECT 1 FROM messages
         WHERE id=$2 AND contact_id=$1)
       AND NOT EXISTS(SELECT 1 FROM messages
         WHERE pricing_reminder_anchor_id=$2)
     ON CONFLICT DO NOTHING
     RETURNING id, reason`,
    [candidate.contact_id, candidate.anchor_id, reason]
  );
  return result.rows[0] || null;
}

async function discard({ messageId, contactId }) {
  const result = await pool.query(
    `DELETE FROM messages WHERE id=$1 AND contact_id=$2
       AND pricing_reminder_anchor_id IS NOT NULL AND delivery_status IS NULL
       AND whatsapp_message_id IS NULL RETURNING id`,
    [messageId,contactId]
  );
  return result.rowCount > 0;
}
module.exports = { listEligible, claim, isClaimStillEligible, recordDecision, discard, finalDueSql, afterFinalMode };
