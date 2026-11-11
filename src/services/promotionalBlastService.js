"use strict";
const { randomUUID }=require("node:crypto");
const { pool }=require("../db/db");
const CAMPAIGN_KEY="ns_3d_1111_rm388_2026";
const CAMPAIGN_LABEL="11.11 3D 小颜术 · RM388";
const LANGUAGES=new Set(["zh_CN","en_US","ms"]);
const CANDIDATE_SQL=String.raw`
WITH campaign AS (
 SELECT campaign_key,template_name,title,promoted_treatment,target_treatments,valid_until FROM whatsapp_promotional_blast_campaigns WHERE campaign_key=$1 AND enabled AND valid_until>now()
),active_leads AS (
  SELECT DISTINCT ON (l.contact_id)
    l.contact_id, l.treatment_interest, l.marketing_consent,
    l.is_closed, l.appointment_status, l.stage_id
  FROM leads l
  JOIN contacts c ON c.id=l.contact_id
  CROSS JOIN campaign settings
  WHERE c.channel='whatsapp' AND c.whatsapp_sender_id IN (1,2)
    AND l.treatment_interest=ANY(settings.target_treatments)
    AND EXISTS (
      SELECT 1 FROM whatsapp_free_entry_referrals r
      JOIN messages origin ON origin.id=r.origin_message_id
      WHERE r.contact_id=c.id AND r.source_type='ad'
        AND origin.created_at>now()-interval '7 days'
    )
  ORDER BY l.contact_id,l.is_closed ASC,l.created_at DESC,l.id DESC
),
candidates AS (
  SELECT c.id AS contact_id, c.whatsapp_sender_id AS sender_id,
    CASE WHEN c.whatsapp_number ~ '^\+?[0-9]{8,15}$'
      THEN regexp_replace(c.whatsapp_number,'[^0-9]','','g')
      ELSE 'contact:'||c.id::text END AS recipient_key,
    COALESCE(NULLIF(c.whatsapp_profile_name,''),NULLIF(c.name,''),'Contact '||c.id) AS contact_name,
    l.treatment_interest, (l.treatment_interest<>campaign.promoted_treatment) AS related_offer_review_required,
    campaign.campaign_key,campaign.template_name,session.first_reply_at,
    session.first_reply_at+interval '167 hours' AS safe_expires_at,
    CASE WHEN inbound.content ~ '[一-龥]' THEN 'zh_CN'
         WHEN lower(coalesce(inbound.content,'')) ~ '(boleh|berapa|rawatan|nak |saya |harga)' THEN 'ms'
         ELSE 'en_US' END AS suggested_language,
    CASE WHEN c.whatsapp_sender_id=2 AND EXISTS (
      SELECT 1 FROM whatsapp_sender_billing_alarms alarm
      WHERE alarm.sender_id=2
    ) THEN 'secondary_billing_alarm'
    WHEN c.whatsapp_sender_id=2 AND EXISTS (
      SELECT 1 FROM whatsapp_sender_billing_gates gate
      WHERE gate.sender_id=c.whatsapp_sender_id AND gate.owner_contact_id=c.id AND gate.contact_id=c.id AND gate.state<>'idle'
    ) THEN 'secondary_billing_unresolved'
    ELSE NULL END AS blocked_reason
  FROM active_leads l
  JOIN contacts c ON c.id=l.contact_id
  CROSS JOIN campaign
  LEFT JOIN pipeline_stages stage ON stage.id=l.stage_id
  JOIN LATERAL (
    SELECT entry.origin_message_id, reply.id AS first_reply_id, reply.created_at AS first_reply_at
    FROM whatsapp_free_entry_referrals entry
    JOIN messages origin ON origin.id=entry.origin_message_id
      AND origin.contact_id=c.id AND origin.role='user'
      AND origin.whatsapp_message_id IS NOT NULL
    JOIN LATERAL (
      SELECT m.id,m.created_at,m.whatsapp_message_id
      FROM messages m
      WHERE m.contact_id=c.id AND m.role='assistant'
        AND m.whatsapp_message_id IS NOT NULL
        AND m.created_at>=origin.created_at
        AND m.created_at<origin.created_at+interval '24 hours'
      ORDER BY m.created_at,m.id LIMIT 1
    ) reply ON true
    WHERE entry.contact_id=c.id AND entry.source_type='ad'
      AND (entry.meta_ad_id IS NOT NULL OR entry.ctwa_clid IS NOT NULL)
      AND origin.created_at>now()-interval '7 days'
      AND reply.created_at>now()-interval '167 hours'
      -- An overlapping repeat ad click must not restart a verified period.
      AND NOT EXISTS (
        SELECT 1 FROM whatsapp_free_entry_referrals earlier_entry
        JOIN messages earlier_origin ON earlier_origin.id=earlier_entry.origin_message_id
          AND earlier_origin.contact_id=c.id AND earlier_origin.role='user'
          AND earlier_origin.whatsapp_message_id IS NOT NULL
        JOIN LATERAL (
          SELECT r.id,r.created_at,r.whatsapp_message_id FROM messages r
          WHERE r.contact_id=c.id AND r.role='assistant'
            AND r.whatsapp_message_id IS NOT NULL
            AND r.created_at>=earlier_origin.created_at
            AND r.created_at<earlier_origin.created_at+interval '24 hours'
          ORDER BY r.created_at,r.id LIMIT 1
        ) earlier_reply ON true
        WHERE earlier_entry.contact_id=c.id AND earlier_entry.source_type='ad'
          AND (earlier_entry.meta_ad_id IS NOT NULL OR earlier_entry.ctwa_clid IS NOT NULL)
          AND earlier_entry.origin_message_id<>entry.origin_message_id
          AND earlier_reply.created_at<reply.created_at
          AND earlier_reply.created_at>reply.created_at-interval '168 hours'
          AND (
            (c.whatsapp_sender_id=1 AND EXISTS (
              SELECT 1 FROM whatsapp_free_entry_pricing_evidence old_price
              WHERE old_price.wamid=earlier_reply.whatsapp_message_id
                AND old_price.pricing_type='free_entry_point'
                AND old_price.billable=false
                AND old_price.delivery_status IN ('sent','delivered','read')
            )) OR (c.whatsapp_sender_id=2 AND EXISTS (
              SELECT 1 FROM whatsapp_sender_status_receipts old_price
              WHERE old_price.sender_id=2
                AND old_price.wamid=earlier_reply.whatsapp_message_id
                AND old_price.matched=true
                AND old_price.pricing_type='free_entry_point'
                AND old_price.pricing_billable=false
                AND old_price.delivery_status IN ('sent','delivered','read')
            ) AND EXISTS (
              SELECT 1 FROM whatsapp_sender_conversations older_sc
              JOIN whatsapp_sender_message_context older_inc
                ON older_inc.conversation_id=older_sc.id
                AND older_inc.message_id=earlier_entry.origin_message_id
              JOIN whatsapp_sender_message_context older_sent
                ON older_sent.conversation_id=older_sc.id
                AND older_sent.message_id=earlier_reply.id
              WHERE older_sc.contact_id=c.id AND older_sc.sender_id=2
                AND older_sc.state='bound'
            ))
          )
      )
      AND now()+interval '10 minutes'<reply.created_at+interval '167 hours'
      AND (
        (c.whatsapp_sender_id=1 AND EXISTS (
          SELECT 1 FROM whatsapp_free_entry_pricing_evidence priced
          WHERE priced.wamid=reply.whatsapp_message_id
            AND priced.pricing_type='free_entry_point'
            AND priced.billable=false
            AND priced.delivery_status IN ('sent','delivered','read')
        )) OR (c.whatsapp_sender_id=2 AND EXISTS (
          SELECT 1 FROM whatsapp_sender_status_receipts priced
          WHERE priced.sender_id=2 AND priced.wamid=reply.whatsapp_message_id
            AND priced.matched=true AND priced.pricing_type='free_entry_point'
            AND priced.pricing_billable=false
            AND priced.delivery_status IN ('sent','delivered','read')
        ) AND EXISTS (
          SELECT 1 FROM whatsapp_sender_conversations sc
          JOIN whatsapp_sender_message_context inc
            ON inc.conversation_id=sc.id AND inc.message_id=entry.origin_message_id
          JOIN whatsapp_sender_message_context sent
            ON sent.conversation_id=sc.id AND sent.message_id=reply.id
          WHERE sc.contact_id=c.id AND sc.sender_id=2 AND sc.state='bound'
        ))
      )
    ORDER BY reply.created_at,reply.id LIMIT 1
  ) session ON true
  JOIN LATERAL (
    SELECT m.created_at,m.content FROM messages m
    WHERE m.contact_id=c.id AND m.role='user'
    ORDER BY m.created_at DESC,m.id DESC LIMIT 1
  ) inbound ON true
  WHERE c.whatsapp_number IS NOT NULL
    -- Fail closed on unlinked BSUID/username aliases until a verified
    -- cross-sender identity mapping is available for blast deduplication.
    AND c.whatsapp_number ~ '^\+?[0-9]{8,15}$'
    AND COALESCE(c.mode,'ai')<>'human' AND c.needs_attention IS FALSE
    AND c.whatsapp_opt_in_at IS NOT NULL
    AND NULLIF(BTRIM(c.whatsapp_opt_in_source),'') IS NOT NULL
    AND c.whatsapp_opt_out_at IS NULL
    AND c.whatsapp_marketing_opt_out_at IS NULL
    AND l.marketing_consent='opted_in' AND l.is_closed=false
    AND COALESCE(l.appointment_status,'none') NOT IN ('set','visited','booked','confirmed')
    AND COALESCE(stage.stage_type,'open')='open'
    AND COALESCE(stage.system_key,'') NOT IN ('appointment_set','visited','confirmed','booked','completed')
    AND EXISTS (
      SELECT 1 FROM whatsapp_marketing_consent_events e
      JOIN messages cm ON cm.id=e.message_id AND cm.contact_id=c.id
        AND cm.role='user' AND cm.whatsapp_message_id IS NOT NULL
      WHERE e.contact_id=c.id AND e.consent_category='MARKETING'
        AND e.consent_scope='treatment_followups_and_related_offers'
        AND e.consent_service=l.treatment_interest
        AND e.consented_at>=c.whatsapp_opt_in_at
        AND (
          c.whatsapp_sender_id=1 OR EXISTS (
            SELECT 1 FROM whatsapp_sender_message_context consent_ctx
            JOIN whatsapp_sender_conversations sc
              ON sc.id=consent_ctx.conversation_id AND sc.contact_id=c.id
                AND sc.sender_id=2 AND sc.state='bound'
            WHERE consent_ctx.message_id=cm.id
          )
        )
    )
    AND inbound.created_at<now()-interval '24 hours'
    AND EXISTS (
      SELECT 1 FROM messages response
      WHERE response.contact_id=c.id AND response.role='assistant'
        AND response.whatsapp_message_id IS NOT NULL
        AND response.created_at>inbound.created_at
        AND response.delivery_status IS DISTINCT FROM 'failed'
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages outgoing
      WHERE outgoing.contact_id=c.id AND outgoing.role='assistant'
        AND outgoing.created_at>now()-interval '5 hours'
        AND outgoing.delivery_status IS DISTINCT FROM 'cancelled'
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages staff
      JOIN users u ON u.username=staff.sent_by_username
      WHERE staff.contact_id=c.id AND staff.role='assistant'
        AND staff.created_at>session.first_reply_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM sales_follow_up_tasks handled
      JOIN leads related ON related.id=handled.lead_id
      WHERE related.contact_id=c.id AND handled.updated_at>=session.first_reply_at
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages declined
      WHERE declined.contact_id=c.id AND declined.role='user'
        AND declined.created_at>=session.first_reply_at
        AND coalesce(declined.content,'') ~* '(stop|unsubscribe|not interested|no thanks|next year|以后再说|暂时先不用|暫時先不用|不要|没兴趣|沒興趣|不需要|tak berminat|jangan hantar)'
    )
    AND NOT EXISTS (
      SELECT 1 FROM messages sent_promo
      WHERE sent_promo.contact_id=c.id AND sent_promo.role='assistant'
        AND sent_promo.whatsapp_template->>'name'=campaign.template_name
    )
    AND now()<campaign.valid_until
    AND NOT EXISTS (
      SELECT 1 FROM clinic_config settings WHERE settings.id=1
        AND COALESCE(settings.data #>> '{automatedFollowUp,quietHours,enabled}','true')='true'
        AND (
          CASE WHEN COALESCE(settings.data #>> '{automatedFollowUp,quietHours,start}','00:00')
                 < COALESCE(settings.data #>> '{automatedFollowUp,quietHours,end}','07:00')
            THEN to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','HH24:MI')
                 >= COALESCE(settings.data #>> '{automatedFollowUp,quietHours,start}','00:00')
             AND to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','HH24:MI')
                 < COALESCE(settings.data #>> '{automatedFollowUp,quietHours,end}','07:00')
            ELSE to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','HH24:MI')
                 >= COALESCE(settings.data #>> '{automatedFollowUp,quietHours,start}','00:00')
              OR to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur','HH24:MI')
                 < COALESCE(settings.data #>> '{automatedFollowUp,quietHours,end}','07:00')
          END
        )
    )
)
SELECT contact_id,sender_id,recipient_key,contact_name,treatment_interest,related_offer_review_required,campaign_key,template_name,first_reply_at,safe_expires_at,suggested_language,blocked_reason
FROM candidates`;
function validKey(value) { return /^[a-z0-9_]{3,100}$/.test(String(value||"")) ? String(value) : null; }

async function getCampaign(key=CAMPAIGN_KEY,database=pool) {
  if(!validKey(key))return null;
  const r=await database.query(
    "SELECT campaign_key,template_name,title,promoted_treatment,target_treatments,valid_until,enabled FROM whatsapp_promotional_blast_campaigns WHERE campaign_key=$1",
    [key]);
  return r.rows?.[0]||null;
}
async function listCampaigns(database=pool) {
  const r=await database.query("SELECT campaign_key,template_name,title,promoted_treatment,target_treatments,valid_until,enabled FROM whatsapp_promotional_blast_campaigns ORDER BY created_at DESC LIMIT 40");
  return r.rows||[];
}
async function createCampaign(input,username,database=pool) {
  const key=validKey(input?.campaignKey), name=validKey(input?.templateName);
  const title=String(input?.title||"").trim(), promoted=String(input?.promotedTreatment||"").trim();
  const targets=Array.isArray(input?.targetTreatments)? [...new Set(input.targetTreatments.map(v=>String(v).trim()))]:[];
  const ends=new Date(input?.validUntil), now=Date.now();
  if(!key||!name||title.length<3||title.length>120||!promoted||promoted.length>120||
    targets.length<1||targets.length>5||targets.some(v=>!v||v.length>120)||!targets.includes(promoted)||
    !Number.isFinite(ends.getTime())||ends.getTime()<=now||ends.getTime()>now+90*86400000||
    !String(username||"").trim())return null;
  const r=await database.query(
    "INSERT INTO whatsapp_promotional_blast_campaigns (campaign_key,template_name,title,promoted_treatment,target_treatments,valid_until,created_by) VALUES ($1,$2,$3,$4,$5::text[],$6,$7) ON CONFLICT DO NOTHING RETURNING campaign_key,template_name,title,promoted_treatment,target_treatments,valid_until,enabled",
    [key,name,title,promoted,targets,ends.toISOString(),username]);
  return r.rows?.[0]||null;
}
async function candidates(key=CAMPAIGN_KEY,database=pool) {
  if(!validKey(key))return [];
  const r=await database.query(`SELECT qualified.*,
    EXISTS(SELECT 1 FROM whatsapp_promotional_blast_claims claim
      WHERE claim.campaign_key=$1 AND claim.recipient_key=qualified.recipient_key
        AND (claim.state='attempted' OR claim.claimed_at>now()-interval '5 minutes')
    ) AS already_claimed
    FROM (${CANDIDATE_SQL}) qualified
    ORDER BY qualified.safe_expires_at,qualified.contact_id LIMIT 100`,[key]);
  return r.rows||[];
}
// A reserved claim is recoverable after 5 minutes only if it has NOT been attempted.
// Token rotation prevents a delayed request from the old tab using it.
async function claimRecipient(contactId,languageCode,staffUsername,{
  campaign=CAMPAIGN_KEY,relatedOfferReviewed=false,database=pool,
}={}) {
  if(!validKey(campaign)||!Number.isSafeInteger(contactId)||contactId<1||
    !LANGUAGES.has(languageCode)||!String(staffUsername||"").trim())return null;
  const token=randomUUID();
  const r=await database.query(`INSERT INTO whatsapp_promotional_blast_claims
    (campaign_key,contact_id,recipient_key,sender_id,language_code,staff_username,reservation_token,related_offer_reviewed)
    SELECT $1,qualified.contact_id,qualified.recipient_key,qualified.sender_id,$3,$4,$5::uuid,$6
    FROM (${CANDIDATE_SQL}) qualified
    WHERE qualified.contact_id=$2 AND qualified.blocked_reason IS NULL
      AND (qualified.related_offer_review_required IS FALSE OR $6 IS TRUE)
    ON CONFLICT (campaign_key,recipient_key) DO UPDATE
      SET contact_id=EXCLUDED.contact_id,sender_id=EXCLUDED.sender_id,
        language_code=EXCLUDED.language_code,staff_username=EXCLUDED.staff_username,
        reservation_token=EXCLUDED.reservation_token,related_offer_reviewed=EXCLUDED.related_offer_reviewed,
        claimed_at=now()
    WHERE whatsapp_promotional_blast_claims.state='reserved'
      AND whatsapp_promotional_blast_claims.claimed_at<now()-interval '5 minutes'
    RETURNING id,contact_id,reservation_token,claimed_at`,
    [campaign,contactId,languageCode,staffUsername,token,relatedOfferReviewed===true]);
  return r.rows?.[0]||null;
}
// During dispatch a message has been staged as "unknown" but not sent.
// Ignore ONLY that exact DB row; all other outgoing, staff, and promo messages
// continue to block, including ones that appeared after the initial preview.
const DISPATCH_SQL=CANDIDATE_SQL
  // Secondary staff dispatch already reserved THIS message's billing gate.
  // Ignore only its matching message_id, not any earlier contact gate.
  .replace("gate.contact_id=c.id AND gate.state<>'idle'",
           "gate.contact_id=c.id AND gate.message_id IS DISTINCT FROM $6::integer AND gate.state<>'idle'")
  .replace("WHERE outgoing.contact_id=c.id", "WHERE outgoing.id<>$6::integer AND outgoing.contact_id=c.id")
  .replace("WHERE staff.contact_id=c.id", "WHERE staff.id<>$6::integer AND staff.contact_id=c.id")
  .replace("WHERE sent_promo.contact_id=c.id", "WHERE sent_promo.id<>$6::integer AND sent_promo.contact_id=c.id");

// Irreversible. Call ONLY immediately before provider contact, after the media is ready.
async function consumeClaim(contactId,campaign,languageCode,staffUsername,token,currentMessageId,database=pool) {
  if(!validKey(campaign)||!Number.isSafeInteger(contactId)||contactId<1||
    !LANGUAGES.has(languageCode)||!String(staffUsername||"").trim()||
    !Number.isSafeInteger(currentMessageId)||currentMessageId<1||
    !/^[0-9a-f-]{36}$/i.test(String(token||"")))return false;
  const r=await database.query(`UPDATE whatsapp_promotional_blast_claims claim
    SET state='attempted',attempted_at=now()
    FROM (${DISPATCH_SQL}) qualified
    WHERE claim.campaign_key=$1 AND claim.contact_id=$2
      AND claim.staff_username=$3 AND claim.language_code=$4
      AND claim.reservation_token=$5::uuid AND claim.state='reserved'
      AND claim.claimed_at>=now()-interval '5 minutes'
      AND qualified.contact_id=claim.contact_id AND qualified.sender_id=claim.sender_id
      AND qualified.recipient_key=claim.recipient_key AND qualified.blocked_reason IS NULL
      AND (qualified.related_offer_review_required IS FALSE OR claim.related_offer_reviewed IS TRUE)
    RETURNING claim.id`,
    [campaign,contactId,staffUsername,languageCode,token,currentMessageId]);
  return r.rows?.length===1;
}
module.exports={CAMPAIGN_KEY,CAMPAIGN_LABEL,LANGUAGES,CANDIDATE_SQL,
  validKey,getCampaign,listCampaigns,createCampaign,candidates,claimRecipient,consumeClaim,DISPATCH_SQL};
