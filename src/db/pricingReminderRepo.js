const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");
const MINUTES_AFTER_TESTIMONIAL = 5;
const WINDOW_SAFETY_MINUTES = 10;
// Persisted provider acceptance is channel-specific. A placeholder is not proof of delivery.
function acceptedFollowUpSql(channel, alias = "") {
  const col = (name) => alias ? `${alias}.${name}` : name;
  return `(
    (${channel} = 'whatsapp'
      AND ${col("whatsapp_accepted_at")} IS NOT NULL
      AND (${col("delivery_status")} IN ('sent', 'delivered', 'read')
        OR (${col("delivery_status")} = 'pending' AND ${col("whatsapp_message_id")} IS NOT NULL)))
    OR (${channel} IN ('facebook', 'instagram')
      AND ${col("social_accepted_at")} IS NOT NULL
      AND ${col("delivery_status")} = 'sent'
      AND ${col("whatsapp_message_id")} LIKE (${channel} || ':%'))
  )`;
}

// Pricing is an auxiliary message, not a sequential fourth step.
const eligibleSql = () => `
WITH eligible AS (
 SELECT
   c.id AS contact_id, c.channel, c.whatsapp_number, c.channel_user_id, anchor.id AS anchor_id,
   anchor.created_at AS anchor_at, inbound.id AS inbound_id,
   inbound.created_at AS inbound_at, third.id AS third_id,
   third.third_accepted_at, lead.treatment_interest,
   third.third_accepted_at + interval '${MINUTES_AFTER_TESTIMONIAL} minutes' AS due_at,
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
            AND delivery_status IS DISTINCT FROM 'cancelled'
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
   SELECT id, CASE WHEN c.channel='whatsapp'
      THEN whatsapp_accepted_at ELSE social_accepted_at END AS third_accepted_at
   FROM messages
   WHERE contact_id = c.id AND is_automated_follow_up = true
     AND automated_follow_up_for_message_id = anchor.id
     AND automated_follow_up_step = 3
     AND ${acceptedFollowUpSql("c.channel")}
   ORDER BY created_at DESC, id DESC LIMIT 1
 ) third ON true
 LEFT JOIN LATERAL (
   SELECT id FROM pricing_reminder_decisions WHERE anchor_id = anchor.id LIMIT 1
 ) decision ON true
 LEFT JOIN LATERAL (
   SELECT l.treatment_interest, l.is_closed, l.appointment_status,
          s.stage_type, s.system_key
   FROM leads l LEFT JOIN pipeline_stages s ON s.id = l.stage_id
   WHERE l.contact_id = c.id ORDER BY l.created_at DESC, l.id DESC LIMIT 1
 ) lead ON true
 WHERE c.channel = ANY($5::text[])
   AND ((c.channel = 'whatsapp' AND c.whatsapp_number IS NOT NULL)
     OR (c.channel IN ('facebook','instagram') AND c.channel_user_id IS NOT NULL))
   AND c.needs_attention = false
   AND COALESCE(c.mode,'ai') <> 'human'
   AND c.whatsapp_opt_out_at IS NULL
   AND c.whatsapp_marketing_opt_out_at IS NULL
   AND anchor.delivery_status IS DISTINCT FROM 'failed'
   AND anchor.delivery_status IS DISTINCT FROM 'cancelled'
   AND anchor.created_at >= $1::timestamptz
   AND ($2::text = 'all' OR anchor.sent_by_username IS NOT NULL)
   -- Allow recent expiry cases to be recorded as insufficient_window.
   AND inbound.created_at > now() - interval '72 hours'
   AND decision.id IS NULL
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
WHERE ($3::timestamptz IS NULL
   OR (due_at, anchor_id) > ($3::timestamptz, $4::integer))
ORDER BY due_at ASC, anchor_id ASC LIMIT 200
`;

async function listEligible({ activatedAt, triggerMode, after = null, channels = ["whatsapp"] }) {
  const allowed = channels.filter((channel) => ["whatsapp","facebook","instagram"].includes(channel));
  const result = await pool.query(eligibleSql(),
    [activatedAt, triggerMode, after?.dueAt || null, after?.anchorId || null, allowed]);
  return result.rows;
}

async function claim({ candidate, offer, activatedAt, triggerMode }) {
  if (!Number.isInteger(Number(candidate.third_id)) || !String(offer?.packageName || '').trim()) return null;
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
         AND delivery_status IS DISTINCT FROM 'cancelled'
         AND (created_at,id) > ((SELECT created_at FROM inbound),(SELECT id FROM inbound))
         AND NOT EXISTS (SELECT 1 FROM outbound_message_evidence e
           WHERE e.message_id=messages.id AND e.origin='system_fallback')
       ORDER BY created_at DESC,id DESC LIMIT 1
     ), third AS (
       SELECT id, CASE WHEN (SELECT channel FROM contacts WHERE id=$1)='whatsapp'
      THEN whatsapp_accepted_at ELSE social_accepted_at END AS third_accepted_at
        FROM messages
        WHERE contact_id=$1 AND is_automated_follow_up=true
         AND automated_follow_up_for_message_id=$2
         AND automated_follow_up_step=3 AND id=$10
         AND ${acceptedFollowUpSql("(SELECT channel FROM contacts WHERE id=$1)")}
       LIMIT 1
     )
     INSERT INTO messages (
       contact_id, role, content, sent_by_username, media_url,
       is_automated_follow_up, automated_follow_up_step, pricing_reminder_anchor_id,
       pricing_reminder_package_key, automated_follow_up_target_service, automated_follow_up_targeting_recorded,
       automated_follow_up_message_mode
     )
     SELECT $1, 'assistant', $3, 'Follow-up automation', $4,
       true, 4, $2, $12, $5, true, 'fixed'
     FROM inbound, anchor, third
     JOIN contacts c ON c.id=$1
     LEFT JOIN LATERAL (
       SELECT l.is_closed, l.appointment_status, s.stage_type,s.system_key
       FROM leads l LEFT JOIN pipeline_stages s ON s.id=l.stage_id
       WHERE l.contact_id=c.id ORDER BY l.created_at DESC,l.id DESC LIMIT 1
     ) lead ON true
     WHERE inbound.id=$6 AND anchor.id=$2
       AND c.channel=$13::text
        AND ((c.channel='whatsapp' AND c.whatsapp_number=$14::text)
          OR (c.channel IN ('facebook','instagram') AND c.channel_user_id=$14::text))
       AND c.needs_attention=false
         AND COALESCE(c.mode,'ai') <> 'human'
         AND c.whatsapp_opt_out_at IS NULL
         AND c.whatsapp_marketing_opt_out_at IS NULL
       AND anchor.created_at >= $7::timestamptz
       AND ($8='all' OR anchor.sent_by_username IS NOT NULL)
       AND now() < inbound.created_at + interval '23 hours 50 minutes'
       AND now() >= third.third_accepted_at + interval '${MINUTES_AFTER_TESTIMONIAL} minutes'
       AND (lead.is_closed IS NULL OR (
          lead.is_closed=false AND COALESCE(lead.stage_type,'open')='open'
          AND (COALESCE(lead.appointment_status,'none') IN ('reschedule','cancelled')
            OR (COALESCE(lead.system_key,'') NOT IN ('appointment_set','visited')
              AND COALESCE(lead.appointment_status,'none') NOT IN ('set','visited')))
       ))
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.pricing_reminder_anchor_id=$2 AND m.pricing_reminder_package_key=$12)
       AND NOT EXISTS (SELECT 1 FROM pricing_reminder_decisions d WHERE d.anchor_id=$2)
       AND COALESCE((SELECT l.treatment_interest FROM leads l
         WHERE l.contact_id=$1 ORDER BY l.created_at DESC,l.id DESC LIMIT 1),'')
          = COALESCE($11::text,'')
       AND NOT EXISTS (SELECT 1 FROM follow_up_ai_decisions d
         WHERE d.contact_id=$1 AND d.trigger_message_id=$2
           AND d.action IN ('skip','human_review'))
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.contact_id=$1
         AND m.role='assistant'
         AND m.delivery_status IS DISTINCT FROM 'cancelled'
         AND m.media_url IS NOT NULL
         AND m.content IS NOT NULL AND m.content <> ''
         AND split_part(regexp_replace(m.media_url, '^https?://[^/]+', ''), '?',1)=ANY($9::text[]))
     ON CONFLICT DO NOTHING
     RETURNING id,contact_id,content,media_url,delivery_status`,
    [candidate.contact_id, candidate.anchor_id, offer.caption, offer.imageUrl,
      offer.serviceName, candidate.inbound_id, activatedAt, triggerMode, offer.identities,
      candidate.third_id, candidate.treatment_interest, offer.packageName,
       candidate.channel, candidate.channel === "whatsapp"
         ? candidate.whatsapp_number : candidate.channel_user_id]
  );
  return result.rows[0] || null;
}

async function isClaimStillEligible({
  messageId, contactId, anchorId, inboundId,
  imageIdentities = [], treatmentInterest = null, thirdId, recipientId, packageKey, channel,
}) {
  const result = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM messages m
       JOIN contacts c ON c.id=m.contact_id
       WHERE m.id=$1 AND m.contact_id=$2 AND m.pricing_reminder_anchor_id=$3
         AND m.pricing_reminder_package_key=$9
         AND m.delivery_status IS NULL AND m.whatsapp_message_id IS NULL
         AND c.needs_attention=false
         AND COALESCE(c.mode,'ai') <> 'human'
         AND c.whatsapp_opt_out_at IS NULL
         AND c.whatsapp_marketing_opt_out_at IS NULL AND c.channel=$10::text
          AND ((c.channel='whatsapp' AND c.whatsapp_number=$8::text)
            OR (c.channel IN ('facebook','instagram') AND c.channel_user_id=$8::text))
         AND EXISTS (
           SELECT 1 FROM messages final
           WHERE final.id=$7 AND final.contact_id=$2
             AND final.is_automated_follow_up=true
             AND final.automated_follow_up_for_message_id=$3
             AND final.automated_follow_up_step=3
             AND ${acceptedFollowUpSql("c.channel", "final")}
              AND now() >=
                 (CASE WHEN c.channel='whatsapp' THEN final.whatsapp_accepted_at
                       ELSE final.social_accepted_at END) + interval '${MINUTES_AFTER_TESTIMONIAL} minutes'
         )
         AND COALESCE((SELECT l.treatment_interest FROM leads l
            WHERE l.contact_id=$2 ORDER BY l.created_at DESC,l.id DESC LIMIT 1),'')
             = COALESCE($6::text,'')
         AND (SELECT id FROM messages WHERE contact_id=$2 AND role='user'
              ORDER BY created_at DESC,id DESC LIMIT 1)=$4
         AND now() < (SELECT created_at FROM messages WHERE id=$4)+interval '23 hours 50 minutes'
         AND (SELECT id FROM messages
              WHERE contact_id=$2 AND role='assistant' AND is_automated_follow_up=false
                AND delivery_status IS DISTINCT FROM 'failed'
                AND delivery_status IS DISTINCT FROM 'cancelled'
                AND NOT EXISTS(SELECT 1 FROM outbound_message_evidence e
                  WHERE e.message_id=messages.id AND e.origin='system_fallback')
                AND (created_at,id) > (SELECT created_at,id FROM messages WHERE id=$4)
              ORDER BY created_at DESC,id DESC LIMIT 1)=$3
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
             AND prior.delivery_status IS DISTINCT FROM 'cancelled'
             AND prior.media_url IS NOT NULL AND prior.content IS NOT NULL
             AND prior.content <> ''
             AND split_part(regexp_replace(prior.media_url, '^https?://[^/]+', ''), '?',1)
               =ANY($5::text[]))
     ) AS eligible`, [messageId, contactId, anchorId, inboundId,
       imageIdentities, treatmentInterest, thirdId, recipientId, packageKey, channel]);
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
       AND ($3 IN ('already_sent','delivery_review') OR NOT EXISTS(SELECT 1 FROM messages WHERE pricing_reminder_anchor_id=$2))
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
       AND whatsapp_message_id IS NULL
       AND NOT EXISTS(SELECT 1 FROM social_provider_message_ids s WHERE s.message_id=messages.id)
       RETURNING id`,
    [messageId,contactId]
  );
  return result.rowCount > 0;
}
module.exports = { listEligible, claim, isClaimStillEligible, recordDecision, discard, eligibleSql, MINUTES_AFTER_TESTIMONIAL, WINDOW_SAFETY_MINUTES };
