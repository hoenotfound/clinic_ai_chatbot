const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");

const MINUTES_AFTER_REPLY = 600;
const MINUTES_AFTER_SECOND = 120;

// The pricing reminder is deliberately outside the 1..3 follow-up sequence:
// it uses its own anchor, leaving progress.max_step and Follow-up 3 unchanged.
const eligibleSql = `
WITH eligible AS (
 SELECT
   c.id AS contact_id, c.whatsapp_number, anchor.id AS anchor_id,
   anchor.created_at AS anchor_at, inbound.id AS inbound_id,
   inbound.created_at AS inbound_at, second.created_at AS second_at,
   lead.treatment_interest,
   GREATEST(
     anchor.created_at + interval '${MINUTES_AFTER_REPLY} minutes',
     second.created_at + interval '${MINUTES_AFTER_SECOND} minutes'
   ) AS due_at,
   (SELECT COALESCE(jsonb_agg(user_messages.content ORDER BY user_messages.created_at DESC, user_messages.id DESC), '[]'::jsonb)
      FROM (SELECT id, content, created_at FROM messages
            WHERE contact_id = c.id AND role = 'user'
              AND created_at >= inbound.created_at - interval '24 hours'
            ORDER BY created_at DESC, id DESC LIMIT 15) user_messages
   ) AS recent_customer_messages,
   (SELECT COALESCE(jsonb_agg(jsonb_build_object(
       'media_url', media.media_url, 'content', media.content, 'delivery_status', media.delivery_status
   )), '[]'::jsonb)
    FROM (SELECT media_url, content, delivery_status FROM messages
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
     AND delivery_status IN ('sent', 'delivered', 'read')
   ORDER BY created_at DESC, id DESC LIMIT 1
 ) second ON true
 LEFT JOIN LATERAL (
   SELECT id FROM messages
   WHERE contact_id = c.id AND is_automated_follow_up = true
     AND automated_follow_up_for_message_id = anchor.id
     AND automated_follow_up_step = 3 LIMIT 1
 ) third ON true
 LEFT JOIN LATERAL (
   SELECT id FROM messages WHERE pricing_reminder_anchor_id = anchor.id LIMIT 1
 ) pricing ON true
 LEFT JOIN LATERAL (
   SELECT l.treatment_interest, l.is_closed, l.appointment_status,
          s.stage_type, s.system_key
   FROM leads l LEFT JOIN pipeline_stages s ON s.id = l.stage_id
   WHERE l.contact_id = c.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1
 ) lead ON true
 WHERE c.channel = 'whatsapp' AND c.whatsapp_number IS NOT NULL
   AND c.needs_attention = false
   AND anchor.delivery_status IS DISTINCT FROM 'failed'
   AND anchor.created_at >= $1::timestamptz
   AND ($2::text = 'all' OR anchor.sent_by_username IS NOT NULL)
   AND inbound.created_at > now() - interval '23 hours 50 minutes'
   AND third.id IS NULL AND pricing.id IS NULL
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

async function listEligible({ activatedAt, triggerMode }) {
  const result = await pool.query(eligibleSql, [activatedAt, triggerMode]);
  return result.rows;
}

async function claim({ candidate, offer, activatedAt, triggerMode }) {
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
         AND (created_at,id) > ((SELECT created_at FROM inbound),(SELECT id FROM inbound))
         AND NOT EXISTS (SELECT 1 FROM outbound_message_evidence e
           WHERE e.message_id=messages.id AND e.origin='system_fallback')
       ORDER BY created_at DESC,id DESC LIMIT 1
     ), second AS (
       SELECT created_at FROM messages
       WHERE contact_id=$1 AND is_automated_follow_up=true
         AND automated_follow_up_for_message_id=$2
         AND automated_follow_up_step=2
         AND delivery_status IN ('sent','delivered','read')
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
       AND anchor.created_at >= $7::timestamptz
       AND ($8='all' OR anchor.sent_by_username IS NOT NULL)
       AND now() < inbound.created_at + interval '23 hours 50 minutes'
       AND now() >= GREATEST(
         anchor.created_at + interval '${MINUTES_AFTER_REPLY} minutes',
         second.created_at + interval '${MINUTES_AFTER_SECOND} minutes'
       )
       AND (lead.is_closed IS NULL OR (
          lead.is_closed=false AND COALESCE(lead.stage_type,'open')='open'
          AND (COALESCE(lead.appointment_status,'none') IN ('reschedule','cancelled')
            OR (COALESCE(lead.system_key,'') NOT IN ('appointment_set','visited')
              AND COALESCE(lead.appointment_status,'none') NOT IN ('set','visited')))
       ))
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.pricing_reminder_anchor_id=$2)
       AND NOT EXISTS (SELECT 1 FROM messages m
         WHERE m.contact_id=$1 AND m.is_automated_follow_up=true
           AND m.automated_follow_up_for_message_id=$2
           AND m.automated_follow_up_step=3)
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
      offer.serviceName, candidate.inbound_id, activatedAt, triggerMode, offer.identities]
  );
  return result.rows[0] || null;
}

async function isClaimStillEligible({ messageId, contactId, anchorId, inboundId }) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM messages m
       JOIN contacts c ON c.id=m.contact_id
       WHERE m.id=$1 AND m.contact_id=$2 AND m.pricing_reminder_anchor_id=$3
         AND m.delivery_status IS NULL AND m.whatsapp_message_id IS NULL
         AND c.needs_attention=false AND c.channel='whatsapp'
         AND (SELECT id FROM messages WHERE contact_id=$2 AND role='user'
              ORDER BY created_at DESC,id DESC LIMIT 1)=$4
         AND now() < (SELECT created_at FROM messages WHERE id=$4)+interval '23 hours 50 minutes'
         AND (SELECT id FROM messages
              WHERE contact_id=$2 AND role='assistant' AND is_automated_follow_up=false
                AND NOT EXISTS(SELECT 1 FROM outbound_message_evidence e
                  WHERE e.message_id=messages.id AND e.origin='system_fallback')
                AND (created_at,id) > (SELECT created_at,id FROM messages WHERE id=$4)
              ORDER BY created_at DESC,id DESC LIMIT 1)=$3
         AND NOT EXISTS(SELECT 1 FROM messages f
           WHERE f.automated_follow_up_for_message_id=$3 AND f.automated_follow_up_step=3)
         AND NOT EXISTS(SELECT 1 FROM follow_up_ai_decisions d
           WHERE d.contact_id=$2 AND d.trigger_message_id=$3 AND d.action IN ('skip','human_review'))
     ) AS eligible`, [messageId,contactId,anchorId,inboundId]);
  return result.rows[0]?.eligible === true;
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
module.exports = { listEligible, claim, isClaimStillEligible, discard };
