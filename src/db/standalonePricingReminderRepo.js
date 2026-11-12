"use strict";
// Standalone Neutro pricing reminder. Never depends on Follow-up 3 or
// changes the existing follow-up scheduler's customer/marketing eligibility.
const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");
const { followUpAttentionAllowedSql } = require("../utils/aiReviewPolicy");
const { temporaryStaffConversationSql } = require("../utils/temporaryStaffConversation");

const ELIGIBLE_SQL = `
WITH latest_inbound AS (
  SELECT DISTINCT ON (m.contact_id)
    m.id, m.contact_id, m.created_at,
    COALESCE(m.source_created_at,m.created_at) AS source_at,
    m.content, m.whatsapp_message_id, m.source_created_at,
    m.is_forwarded
  FROM messages m
  WHERE m.role='user' AND m.created_at > NOW()-INTERVAL '25 hours'
  ORDER BY m.contact_id,m.created_at DESC,m.id DESC
)
SELECT c.id AS contact_id,c.channel,c.whatsapp_number,
       c.whatsapp_sender_id,sa.sender_key AS whatsapp_sender_key,
       inbound.id AS inbound_id,inbound.created_at AS inbound_at,
       inbound.source_at,lead.treatment_interest,
       NULL::text AS ad_name,
       (SELECT COALESCE(jsonb_agg(recent.content ORDER BY recent.created_at DESC,recent.id DESC),'[]'::jsonb)
        FROM (SELECT u.id,u.content,u.created_at FROM messages u
              WHERE u.contact_id=c.id AND u.role='user'
                AND u.created_at>=inbound.created_at-INTERVAL '24 hours'
              ORDER BY u.created_at DESC,u.id DESC LIMIT 15) recent
       ) AS recent_customer_messages,
       (SELECT COALESCE(jsonb_agg(jsonb_build_object(
         'media_url',media.media_url,'content',media.content,
         'delivery_status',media.delivery_status,
         'whatsapp_message_id',media.whatsapp_message_id)),'[]'::jsonb)
        FROM (SELECT x.media_url,x.content,x.delivery_status,x.whatsapp_message_id
              FROM messages x WHERE x.contact_id=c.id AND x.role='assistant'
                AND x.media_url IS NOT NULL AND x.media_url<>''
                AND x.delivery_status IS DISTINCT FROM 'cancelled'
              ORDER BY x.created_at DESC,x.id DESC LIMIT 150) media
       ) AS sent_media
FROM latest_inbound inbound
JOIN contacts c ON c.id=inbound.contact_id
JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
  AND sa.state='active' AND sa.sender_key=ANY($1::text[])
LEFT JOIN LATERAL (
  SELECT l.treatment_interest,l.is_closed,l.appointment_status,
         s.stage_type,s.system_key
  FROM leads l LEFT JOIN pipeline_stages s ON s.id=l.stage_id
  WHERE l.contact_id=c.id ORDER BY l.created_at DESC,l.id DESC LIMIT 1
) lead ON TRUE
WHERE c.channel='whatsapp' AND c.whatsapp_number IS NOT NULL
  AND c.mode='ai' AND c.takeover_by IS NULL
  AND ${followUpAttentionAllowedSql("c")}
  AND c.whatsapp_opt_out_at IS NULL AND c.whatsapp_marketing_opt_out_at IS NULL
  AND inbound.created_at >= $2::timestamptz
  AND inbound.source_at <= NOW()
  AND inbound.source_at > NOW()-INTERVAL '23 hours 45 minutes'
  AND inbound.whatsapp_message_id LIKE 'wamid.%'
  AND inbound.is_forwarded IS DISTINCT FROM TRUE
  AND (sa.sender_key <> 'neutro_secondary' OR (
    inbound.source_created_at IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM whatsapp_sender_conversations sc
      JOIN whatsapp_sender_message_context ctx ON ctx.conversation_id=sc.id
        AND ctx.message_id=inbound.id
      WHERE sc.contact_id=c.id AND sc.sender_id=sa.id
        AND sc.customer_wa_id=c.whatsapp_number AND sc.state='bound')
    AND NOT EXISTS (
      SELECT 1 FROM whatsapp_sender_coexistence_history_messages history
      WHERE history.sender_id=sa.id AND history.message_id=inbound.id)))
  AND NOT ${temporaryStaffConversationSql("c","inbound")}
  AND COALESCE(inbound.content,'') !~*
     '^(谢谢|謝謝|多谢|多謝|thanks|thank you|tq|terima kasih)[[:space:].!！。🙏😊]*$'
  AND COALESCE(inbound.content,'') !~*
     '(不要了|不需要|没兴趣|沒興趣|not interested|stop promotions|tak berminat|不要优惠|停止优惠)'
  AND (lead.is_closed IS NULL OR
       (lead.is_closed=FALSE AND COALESCE(lead.stage_type,'open')='open'
        AND COALESCE(lead.appointment_status,'none') NOT IN
            ('set','visited','confirmed','booked','completed')
        AND COALESCE(lead.system_key,'') NOT IN ('appointment_set','visited')))
  -- A verified business response is required; an unreadable/unsupported
  -- inbound or an unreplied customer is not a pricing campaign.
  AND EXISTS (
    SELECT 1 FROM messages reply
    WHERE reply.contact_id=c.id AND reply.role='assistant'
      AND (reply.created_at,reply.id)>(inbound.created_at,inbound.id)
      AND reply.is_automated_follow_up IS DISTINCT FROM TRUE
      AND reply.whatsapp_message_id LIKE 'wamid.%'
      AND reply.delivery_status IN ('sent','delivered','read')
      AND NOT EXISTS (
        SELECT 1 FROM outbound_message_evidence e
        WHERE e.message_id=reply.id AND e.origin='system_fallback'))
  -- When staff or AI has already quoted a price, don't send another.
  -- An uncertain image is treated as a human-review case by the selector.
  AND NOT EXISTS (
    SELECT 1 FROM messages quote
    WHERE quote.contact_id=c.id AND quote.role='assistant'
      AND quote.created_at>=inbound.created_at-INTERVAL '24 hours'
      AND quote.pricing_reminder_anchor_id IS NULL
      AND quote.whatsapp_message_id IS NOT NULL
      AND quote.delivery_status IN ('sent','delivered','read')
      AND COALESCE(quote.content,'') ~* 'RM[[:space:]]*[0-9]')
  AND NOT EXISTS (
    SELECT 1 FROM messages prior
    WHERE prior.pricing_reminder_anchor_id=inbound.id)
ORDER BY inbound.source_at ASC,c.id ASC LIMIT 500
`;

async function listCandidates({senderKeys,activatedAt},database=pool){
  if(!senderKeys.length || !Number.isFinite(Date.parse(activatedAt)))return[];
  const result=await database.query(ELIGIBLE_SQL,[senderKeys,activatedAt]);
  return result.rows||[];
}

// Read again after obtaining the actual sender's outbound/billing proof.
async function stillEligible(candidate,messageId,{senderKeys,activatedAt},database=pool){
  const result=await database.query(`
    SELECT EXISTS(
      SELECT 1 FROM messages outbound
      JOIN contacts c ON c.id=outbound.contact_id
      JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
      JOIN messages inbound ON inbound.id=$2 AND inbound.contact_id=c.id
      WHERE outbound.id=$1 AND outbound.contact_id=$3
        AND outbound.pricing_reminder_anchor_id=inbound.id
        AND outbound.whatsapp_message_id IS NULL
        AND inbound.role='user' AND inbound.whatsapp_message_id LIKE 'wamid.%'
        AND inbound.created_at >= $4::timestamptz
        AND COALESCE(inbound.source_created_at,inbound.created_at)>NOW()-INTERVAL '23 hours 45 minutes'
        AND (SELECT newer.id FROM messages newer WHERE newer.contact_id=c.id
             AND newer.role='user' ORDER BY newer.created_at DESC,newer.id DESC LIMIT 1)=inbound.id
        AND c.channel='whatsapp' AND c.mode='ai' AND c.takeover_by IS NULL
        AND c.whatsapp_opt_out_at IS NULL AND c.whatsapp_marketing_opt_out_at IS NULL
        AND ${followUpAttentionAllowedSql("c")}
        AND sa.id=$5 AND sa.sender_key=ANY($6::text[]) AND sa.state='active'
        AND NOT ${temporaryStaffConversationSql("c","inbound")}
        AND NOT EXISTS(
          SELECT 1 FROM messages quote WHERE quote.contact_id=c.id AND quote.role='assistant'
            AND quote.pricing_reminder_anchor_id IS NULL
            AND quote.created_at>outbound.created_at
            AND quote.whatsapp_message_id IS NOT NULL
            AND quote.delivery_status IN ('sent','delivered','read')
            AND quote.content ~* 'RM[[:space:]]*[0-9]')
        AND NOT EXISTS (
          SELECT 1 FROM leads l LEFT JOIN pipeline_stages s ON s.id=l.stage_id
          WHERE l.id=(SELECT recent.id FROM leads recent WHERE recent.contact_id=c.id
                      ORDER BY recent.created_at DESC,recent.id DESC LIMIT 1)
            AND (l.is_closed=TRUE OR COALESCE(l.appointment_status,'none') IN
              ('set','visited','confirmed','booked','completed')
              OR COALESCE(s.system_key,'') IN ('appointment_set','visited')))
    ) AS allowed
  `,[messageId,candidate.inbound_id,candidate.contact_id,activatedAt,
      candidate.whatsapp_sender_id,senderKeys]);
  return result.rows?.[0]?.allowed===true;
}

// Existing unique (pricing_reminder_anchor_id, package_key) index prevents
// replay across worker crashes. A claim is never treated as unsent after a
// Meta request has possibly started.
async function claim(candidate,offer,database=pool){
  const result=await database.query(`
    WITH lock AS (SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE},$1::integer))
    INSERT INTO messages(
      contact_id,role,content,sent_by_username,media_url,
      is_automated_follow_up,automated_follow_up_step,
      pricing_reminder_anchor_id,pricing_reminder_package_key,
      automated_follow_up_target_service,automated_follow_up_targeting_recorded,
      automated_follow_up_message_mode,delivery_status,delivery_error)
    SELECT $1,'assistant',$3,'Follow-up automation',$4,
           TRUE,4,$2,$5,$6,TRUE,'fixed','unknown',
           'Scheduled pricing graphic is awaiting Meta acceptance.'
    FROM lock
    WHERE NOT EXISTS(
       SELECT 1 FROM messages prior WHERE prior.pricing_reminder_anchor_id=$2)
      AND EXISTS(SELECT 1 FROM contacts c
        JOIN messages inbound ON inbound.id=$2 AND inbound.contact_id=c.id
        WHERE c.id=$1 AND c.mode='ai' AND c.takeover_by IS NULL
          AND c.whatsapp_sender_id=$7 AND inbound.role='user'
          AND (SELECT recent.id FROM messages recent
               WHERE recent.contact_id=c.id AND recent.role='user'
               ORDER BY recent.created_at DESC,recent.id DESC LIMIT 1)=inbound.id)
    ON CONFLICT DO NOTHING RETURNING id,contact_id,delivery_status
  `,[candidate.contact_id,candidate.inbound_id,offer.caption,offer.imageUrl,
      offer.packageName,offer.serviceName,candidate.whatsapp_sender_id]);
  return result.rows?.[0]||null;
}

async function claimAdditional(candidate,offer,database=pool){
  const result=await database.query(`
    WITH lock AS (SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE},$1::integer))
    INSERT INTO messages(
      contact_id,role,content,sent_by_username,media_url,is_automated_follow_up,
      automated_follow_up_step,pricing_reminder_anchor_id,pricing_reminder_package_key,
      automated_follow_up_target_service,automated_follow_up_targeting_recorded,
      automated_follow_up_message_mode,delivery_status,delivery_error)
    SELECT $1,'assistant',$3,'Follow-up automation',$4,TRUE,4,$2,$5,
           $6,TRUE,'fixed','unknown','Scheduled pricing graphic awaiting Meta acceptance.'
    FROM lock WHERE EXISTS(
      SELECT 1 FROM messages previous WHERE previous.pricing_reminder_anchor_id=$2
        AND previous.contact_id=$1 AND previous.whatsapp_message_id IS NOT NULL
        AND previous.delivery_status IN ('sent','delivered','read')
        AND previous.pricing_reminder_package_key<>$5)
      AND NOT EXISTS(
        SELECT 1 FROM messages same WHERE same.pricing_reminder_anchor_id=$2
        AND same.pricing_reminder_package_key=$5)
    ON CONFLICT DO NOTHING RETURNING id,contact_id,delivery_status
  `,[candidate.contact_id,candidate.inbound_id,offer.caption,offer.imageUrl,
     offer.packageName,offer.serviceName]);
  return result.rows?.[0]||null;
}
module.exports={ELIGIBLE_SQL,listCandidates,stillEligible,claim,claimAdditional};
