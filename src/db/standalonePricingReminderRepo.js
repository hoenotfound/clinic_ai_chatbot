"use strict";
// Standalone Neutro pricing reminder. Never depends on Follow-up 3 or
// changes the existing follow-up scheduler's customer/marketing eligibility.
const { pool } = require("./db");
const { CONVERSATION_LOCK_NAMESPACE } = require("./conversationLock");
const { followUpAttentionAllowedSql } = require("../utils/aiReviewPolicy");
const { temporaryStaffConversationSql } = require("../utils/temporaryStaffConversation");
const { acceptedNormalOutboundSql } = require("../utils/normalOutboundProofSql");

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
       EXISTS (SELECT 1 FROM messages first_price
         WHERE first_price.pricing_reminder_anchor_id=inbound.id
           AND first_price.pricing_reminder_package_key='Package A'
           AND first_price.whatsapp_message_id LIKE 'wamid.%'
           AND (first_price.delivery_status IN ('sent','delivered','read')
             OR (first_price.delivery_status='pending'
               AND first_price.whatsapp_accepted_at IS NOT NULL))
       ) AS has_accepted_package_a,
       (SELECT MIN(retry.retry_after) FROM pricing_reminder_preflight_retries retry
        WHERE retry.anchor_id=inbound.id AND retry.attempts<3) AS next_preflight_retry_at,
       (SELECT MAX(busy.created_at) FROM messages busy
        WHERE busy.contact_id=c.id AND busy.role='assistant'
          AND busy.created_at>=inbound.created_at
          AND busy.whatsapp_message_id IS NOT NULL
          AND (busy.delivery_status IS NULL OR busy.delivery_status IN
             ('pending','sent','delivered','read'))
          AND (busy.is_automated_follow_up=TRUE
            OR busy.sent_by_username='Consent request automation')
          AND busy.pricing_reminder_anchor_id IS NULL
       ) AS last_automation_at,
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
                AND NOT (x.delivery_status='queued'
                  AND x.pricing_reminder_anchor_id=inbound.id
                  AND x.whatsapp_message_id IS NULL
                  AND x.whatsapp_accepted_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM whatsapp_sender_billing_attempts q
                    WHERE q.message_id=x.id AND q.state<>'rejected'))
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
  AND NULLIF(BTRIM(inbound.content),'') IS NOT NULL
  AND inbound.content NOT LIKE '📎 [%sent a WhatsApp message that could not be displayed]%'
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
     '(不要了|不需要|没兴趣|沒興趣|not interested|stop promotions|unsubscribe|tak berminat|不要优惠|停止优惠|停止推送|停止跟进|停止跟進)'
  AND NOT EXISTS (
    SELECT 1 FROM whatsapp_sender_followup_treatment_state withdrawal
    WHERE withdrawal.sender_id=sa.id AND withdrawal.contact_id=c.id
      AND withdrawal.status IN ('declined','deferred')
      AND withdrawal.source_message_id<=inbound.id)
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
      AND ${acceptedNormalOutboundSql("reply")}
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
      AND (quote.delivery_status IS NULL OR quote.delivery_status IN ('pending','sent','delivered','read'))
      AND COALESCE(quote.content,'') ~* '(RM[[:space:]]*[0-9]|(price|pricing|cost|promo|package|harga|价格|價錢|价钱|优惠|套餐|配套).{0,80}[0-9]{2,4}|[0-9]{2,4}.{0,80}(price|cost|harga|价格|價錢|价钱))')
  AND (
    NOT EXISTS(SELECT 1 FROM messages prior
               WHERE prior.pricing_reminder_anchor_id=inbound.id)
    OR (
      EXISTS(SELECT 1 FROM messages a
        WHERE a.pricing_reminder_anchor_id=inbound.id
          AND a.pricing_reminder_package_key='Package A'
          AND a.whatsapp_message_id LIKE 'wamid.%'
          AND (a.delivery_status IN ('sent','delivered','read') OR
            (a.delivery_status='pending' AND a.whatsapp_accepted_at IS NOT NULL)))
      AND NOT EXISTS(SELECT 1 FROM messages uncertain
        WHERE uncertain.pricing_reminder_anchor_id=inbound.id
          AND uncertain.pricing_reminder_package_key <> 'Package A'
          AND uncertain.delivery_status NOT IN ('queued','cancelled'))
    )
    OR (
      EXISTS(SELECT 1 FROM messages deferred
        WHERE deferred.pricing_reminder_anchor_id=inbound.id
          AND deferred.delivery_status='queued'
          AND deferred.whatsapp_message_id IS NULL
          AND deferred.whatsapp_accepted_at IS NULL
          AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts pending
                         WHERE pending.message_id=deferred.id AND pending.state<>'rejected'))
      AND NOT EXISTS(SELECT 1 FROM messages other
        WHERE other.pricing_reminder_anchor_id=inbound.id
          AND other.delivery_status NOT IN ('queued','cancelled'))
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM pricing_reminder_preflight_retries exhausted
    WHERE exhausted.anchor_id=inbound.id AND exhausted.attempts>=3)
ORDER BY inbound.source_at ASC,c.id ASC LIMIT 500
`;

async function listCandidates({senderKeys,activatedAt},database=pool){
  if(!senderKeys.length || !Number.isFinite(Date.parse(activatedAt)))return[];
  const result=await database.query(ELIGIBLE_SQL,[senderKeys,activatedAt]);
  return result.rows||[];
}

// Read again after obtaining the actual sender's outbound/billing proof.
async function stillEligible(candidate,messageId,{senderKeys,activatedAt},offer,database=pool){
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
        AND NULLIF(BTRIM(inbound.content),'') IS NOT NULL
        AND inbound.content NOT LIKE '📎 [%sent a WhatsApp message that could not be displayed]%'
        AND inbound.created_at >= $4::timestamptz
        AND COALESCE(inbound.source_created_at,inbound.created_at)>NOW()-INTERVAL '23 hours 45 minutes'
        AND (SELECT newer.id FROM messages newer WHERE newer.contact_id=c.id
             AND newer.role='user' ORDER BY newer.created_at DESC,newer.id DESC LIMIT 1)=inbound.id
        AND c.channel='whatsapp' AND c.mode='ai' AND c.takeover_by IS NULL
        AND c.whatsapp_opt_out_at IS NULL AND c.whatsapp_marketing_opt_out_at IS NULL
        AND ${followUpAttentionAllowedSql("c")}
        AND sa.id=$5 AND sa.sender_key=ANY($6::text[]) AND sa.state='active'
        AND NOT EXISTS (
          SELECT 1 FROM whatsapp_sender_followup_treatment_state withdrawal
          WHERE withdrawal.sender_id=sa.id AND withdrawal.contact_id=c.id
            AND withdrawal.status IN ('declined','deferred')
            AND withdrawal.source_message_id<=inbound.id)
        AND NOT ${temporaryStaffConversationSql("c","inbound")}
        -- A follow-up or opt-in prompt could have been accepted between
        -- the scheduled candidate scan and this provider send.
        AND NOT EXISTS (
          SELECT 1 FROM messages busy WHERE busy.contact_id=c.id
            AND busy.id<>outbound.id AND busy.role='assistant'
            AND busy.pricing_reminder_anchor_id IS NULL
            AND busy.created_at>NOW()-INTERVAL '45 minutes'
            AND busy.whatsapp_message_id IS NOT NULL
            AND (busy.delivery_status IS NULL OR busy.delivery_status IN
                ('pending','sent','delivered','read'))
            AND (busy.is_automated_follow_up=TRUE OR
                 busy.sent_by_username='Consent request automation'))
        AND NOT EXISTS(
          SELECT 1 FROM messages quote WHERE quote.contact_id=c.id AND quote.role='assistant'
            AND quote.pricing_reminder_anchor_id IS NULL
            AND quote.created_at>=inbound.created_at-INTERVAL '24 hours'
            AND quote.whatsapp_message_id IS NOT NULL
            AND (quote.delivery_status IS NULL OR quote.delivery_status IN ('pending','sent','delivered','read'))
            AND quote.content ~* '(RM[[:space:]]*[0-9]|(price|pricing|cost|promo|package|harga|价格|價錢|价钱|优惠|套餐|配套).{0,80}[0-9]{2,4}|[0-9]{2,4}.{0,80}(price|cost|harga|价格|價錢|价钱))')
        AND NOT EXISTS (
          SELECT 1 FROM messages media
          WHERE media.contact_id=c.id AND media.role='assistant'
            AND media.id<>outbound.id
            AND media.media_url IS NOT NULL AND media.media_url<>''
            AND regexp_replace(trim(trailing '/' FROM
              split_part(media.media_url,'?',1)),
              '^https?://[^/]+','') = ANY($7::text[])
            AND media.delivery_status IS DISTINCT FROM 'cancelled'
            AND NOT (media.delivery_status='queued'
              AND media.whatsapp_message_id IS NULL
              AND media.whatsapp_accepted_at IS NULL
              AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts q
                             WHERE q.message_id=media.id AND q.state<>'rejected')))
        AND NOT EXISTS (
          SELECT 1 FROM leads l LEFT JOIN pipeline_stages s ON s.id=l.stage_id
          WHERE l.id=(SELECT recent.id FROM leads recent WHERE recent.contact_id=c.id
                      ORDER BY recent.created_at DESC,recent.id DESC LIMIT 1)
            AND (l.is_closed=TRUE OR COALESCE(l.appointment_status,'none') IN
              ('set','visited','confirmed','booked','completed')
              OR COALESCE(s.system_key,'') IN ('appointment_set','visited')))
    ) AS allowed
  `,[messageId,candidate.inbound_id,candidate.contact_id,activatedAt,
      candidate.whatsapp_sender_id,senderKeys,offer?.identities||[]]);
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
    ON CONFLICT DO NOTHING RETURNING id,contact_id,delivery_status,pricing_reminder_package_key
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
        AND (previous.delivery_status IN ('sent','delivered','read') OR
             (previous.delivery_status='pending' AND previous.whatsapp_accepted_at IS NOT NULL))
        AND previous.pricing_reminder_package_key='Package A'
        AND (
          EXISTS(SELECT 1 FROM whatsapp_sender_accounts own
                 WHERE own.id=$7 AND own.sender_key<>'neutro_secondary')
          OR EXISTS (
            SELECT 1 FROM whatsapp_sender_billing_attempts att
            JOIN whatsapp_sender_status_receipts receipt
              ON receipt.sender_id=att.sender_id
              AND receipt.reservation_id=att.reservation_id
              AND receipt.wamid=previous.whatsapp_message_id
            WHERE att.sender_id=$7 AND att.message_id=previous.id
              AND receipt.matched=TRUE
              AND receipt.delivery_status IN ('sent','delivered','read')
          )))
      AND EXISTS (
        SELECT 1 FROM contacts c
        JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
        WHERE c.id=$1 AND c.mode='ai' AND c.takeover_by IS NULL
          AND c.whatsapp_sender_id=$7
          AND (
            sa.sender_key<>'neutro_secondary' OR EXISTS(
              SELECT 1 FROM whatsapp_sender_billing_gates gate
              WHERE gate.sender_id=sa.id AND gate.owner_contact_id=c.id
                AND gate.state='idle'
                AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_alarms alarm
                               WHERE alarm.sender_id=sa.id)
            ))
      )
      AND NOT EXISTS(
        SELECT 1 FROM messages same WHERE same.pricing_reminder_anchor_id=$2
        AND same.pricing_reminder_package_key=$5)
    ON CONFLICT DO NOTHING RETURNING id,contact_id,delivery_status,pricing_reminder_package_key
  `,[candidate.contact_id,candidate.inbound_id,offer.caption,offer.imageUrl,
     offer.packageName,offer.serviceName,candidate.whatsapp_sender_id]);
  return result.rows?.[0]||null;
}



// No Meta reservation, accepted provider ID or unresolved delivery may be
// present when a preflight rejection becomes safely retryable.
async function deferUnsent(candidate,row,code,database=pool){
  const result=await database.query(
    `UPDATE messages m SET delivery_status='queued',
       delivery_error='Pricing image not sent: pre-provider block ('||$3||').'
     WHERE m.id=$1 AND m.contact_id=$2
       AND m.pricing_reminder_anchor_id=$4
       AND m.whatsapp_message_id IS NULL AND m.whatsapp_accepted_at IS NULL
       AND m.delivery_status IN ('unknown','queued')
       AND NOT EXISTS(
         SELECT 1 FROM whatsapp_sender_billing_attempts attempt
         WHERE attempt.message_id=m.id AND attempt.state<>'rejected')
     RETURNING m.id,m.contact_id,m.delivery_status,m.pricing_reminder_package_key`,
    [row.id,candidate.contact_id,String(code||"preflight").slice(0,80),candidate.inbound_id]
  );
  if(result.rows?.length!==1)return null;
  const retryRows=await database.query(
    `INSERT INTO pricing_reminder_preflight_retries
       (anchor_id,contact_id,package_key,attempts,retry_after,last_error)
     VALUES($1,$2,$3,1,NOW()+INTERVAL '30 seconds',$4)
     ON CONFLICT (anchor_id,package_key) DO UPDATE
       SET attempts=LEAST(pricing_reminder_preflight_retries.attempts+1,3),
           retry_after=NOW()+
             CASE pricing_reminder_preflight_retries.attempts
               WHEN 1 THEN INTERVAL '1 minute'
               ELSE INTERVAL '2 minutes' END,
           last_error=EXCLUDED.last_error,updated_at=NOW()
     RETURNING attempts,retry_after`,
    [candidate.inbound_id,candidate.contact_id,
     result.rows[0].pricing_reminder_package_key,
     "standalone:"+String(code||"blocked").slice(0,160)]
  );
  const retry=retryRows.rows?.[0]||null;
  return {row:result.rows[0],retry};
}

// Reusing an unsent row is permitted only after its recorded backoff, with
// no sender billing attempt or provider receipt. Unknown outcome is never
// eligible for this path.
async function resumeDeferred(candidate,offer,database=pool){
  const result=await database.query(
    `UPDATE messages m SET delivery_status='unknown',
       delivery_error='Pricing reminder resumed after verified pre-provider block.'
     WHERE m.contact_id=$1 AND m.pricing_reminder_anchor_id=$2
       AND m.pricing_reminder_package_key=$3 AND m.delivery_status='queued'
       AND m.whatsapp_message_id IS NULL AND m.whatsapp_accepted_at IS NULL
       AND EXISTS(SELECT 1 FROM pricing_reminder_preflight_retries retry
         WHERE retry.anchor_id=m.pricing_reminder_anchor_id
           AND retry.package_key=m.pricing_reminder_package_key
           AND retry.attempts<3 AND retry.retry_after<=NOW())
       AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts attempt
         WHERE attempt.message_id=m.id AND attempt.state<>'rejected')
       AND EXISTS(SELECT 1 FROM contacts c
          WHERE c.id=m.contact_id AND c.mode='ai'
            AND c.takeover_by IS NULL AND c.whatsapp_sender_id=$4)
     RETURNING m.id,m.contact_id,m.delivery_status,m.pricing_reminder_package_key`,
    [candidate.contact_id,candidate.inbound_id,offer.packageName,
     candidate.whatsapp_sender_id]
  );
  return result.rows?.[0]||null;
}


// Only staff-outbound images are considered. The SQL never returns R2 media
// keys or downloads image bytes. Failed/cancelled media are not duplicates.
// A 7-day search finds a prior manual price graphic from the same enquiry;
// the classifier only puts unrelated/uncaptioned images on hold if they belong
// to the current 24-hour session.
async function listRecentStaffImages(candidate,database=pool){
  if(!candidate?.contact_id||!candidate?.inbound_id)return[];
  const result=await database.query(
    `SELECT m.id,m.content,m.media_url,m.media_mime_type,m.delivery_status,
            m.whatsapp_message_id,m.whatsapp_accepted_at,m.created_at,
            m.sent_by_username
     FROM messages m
     JOIN messages inbound ON inbound.id=$2 AND inbound.contact_id=m.contact_id
     WHERE m.contact_id=$1 AND m.role='assistant'
       AND m.pricing_reminder_anchor_id IS NULL
       AND m.is_automated_follow_up IS DISTINCT FROM TRUE
       AND m.sent_by_username IS NOT NULL
       AND (m.media_key IS NOT NULL OR NULLIF(m.media_url,'') IS NOT NULL)
       AND (m.media_mime_type LIKE 'image/%' OR
            (m.media_mime_type IS NULL AND m.media_key IS NOT NULL))
       AND m.created_at>=GREATEST(NOW()-INTERVAL '7 days',
                                  inbound.created_at-INTERVAL '24 hours')
       AND m.delivery_status IS DISTINCT FROM 'cancelled'
       AND m.delivery_status IS DISTINCT FROM 'failed'
     ORDER BY m.created_at DESC,m.id DESC LIMIT 40`,
    [candidate.contact_id,candidate.inbound_id]
  );
  return result.rows||[];
}

async function recordDecision(candidate,reason,database=pool){
  if(!candidate?.contact_id||!candidate?.inbound_id)return;
  const safe=String(reason||"unknown").slice(0,145);
  await database.query(
    `INSERT INTO standalone_pricing_reminder_decisions
      (contact_id,inbound_message_id,reason)
     VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id`,
    [candidate.contact_id,candidate.inbound_id,"standalone:"+safe]
  );
  return result.rows?.length===1;
}
module.exports={ELIGIBLE_SQL,listCandidates,stillEligible,claim,claimAdditional,deferUnsent,resumeDeferred,recordDecision,listRecentStaffImages};
