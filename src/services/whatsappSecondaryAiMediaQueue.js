"use strict";
const {deliveryOnlySql,deliveryOnlyEnabled}=require("../utils/whatsappSecondaryDeliveryOnly");
const { alignedIdleRecoveryDelay } = require("../utils/maintenanceWindow");


// One-shot sender-owned picture queue. Never use Neutro's strict-RM0 media
// worker, media ID, provider token, retry API or billing reservations.
const {pool}=require("../db/db");
const contactsRepo=require("../db/contactsRepo");
const conversationStore=require("../utils/conversationStore");
const messagesRepo=require("../db/messagesRepo");
const secondaryPolicy=require("./whatsappSecondaryPolicyService");
const {sendSecondaryStaffText}=require("./whatsappSecondaryStaffDispatch");
const {secondaryUsesPrimaryClinicContent}=require("./whatsappSenderActivationGate");
const clinicImage=require("./whatsappSecondaryClinicImage");
const mediaApproval=require("./whatsappSecondaryClinicMediaAuthorization");
const {latestQueuedLanguagePreference,resolveQueuedMediaLanguage,
  queuedMediaLanguageStillCurrent}=require("../utils/queuedMediaLanguage");
const configRepo=require("../db/configRepo");
const {createAdaptiveWorkerTimer}=require("../utils/adaptiveWorkerTimer");
const realtimeEvents=require("../utils/realtimeEvents");
const {configuredVerifiedScope}=require("../utils/verifiedWhatsAppEventScope");
const {resultSupersessionSql,promotionSupersessionSql}=require("../utils/resultMediaSupersessionSql");
const {reconcileSecondaryMediaAudit,reconcileRecentTerminalMediaAudit}=
  require("./whatsappSecondaryAiMediaAudit");
const { secondaryAutomationActivation, secondaryAutomationEligibleSql,
  isSecondaryAutomationEligible,originalAdsOnlyCutoff,secondaryAutomationAttentionAllowedSql } = require("./whatsappSecondaryAdsOnlyEligibility");


/**
 * Customer replies must not cancel an already-selected Before & After result.
 * Promotions keep their narrow continuation rule. Stop requests, newer result
 * plans and staff takeover still supersede media before dispatch.
 * Keep the rule aligned in READY, STILL_VALID and cleanup queries.
 */
const HARMLESS_QUESTION_EN =
  "^(location|location please|address|address please|where is (your )?(clinic|shop)|is it manual|is this manual|is it hifu|does it use hifu|alamat|lokasi)[ ?.!]*$";
const HARMLESS_QUESTION_ZH =
  "^(请问)?(是徒手吗|是徒手嗎|是手法吗|是手法嗎|是hifu吗|是hifu嗎)[ ?？。!！]*$";
// Only very short, non-clinical facial-shape replies may preserve an
// already-selected 3D result. A pelvic plan must never survive a switch
// to facial interest; price requests and new media plans still supersede it.
const FACE_SHAPE_ZH=
  "^(四方脸|四方臉|方脸|方臉|大小脸|大小臉|脸大|臉大|双下巴|雙下巴|下颌线|下顎線|下頜線)[。.!！\\s]*$";
const FACE_SHAPE_EN=
  "^(square face|wide face|uneven face|asymmetric face|jawline|double chin)[.!\\s]*$";
const FACE_SHAPE_MS=
  "^(muka petak|muka lebar|dagu berlapis|rahang)[.!\\s]*$";
const FACE_SHAPE_3D_ANCHOR="(3[[:space:]]*d|小颜|小顏)";
function isHarmlessContinuationQuestion(value,{mediaKind=null,inboundText=""}={}) {
  if (typeof value !== "string") return false;
  const message=value.trim();
  if(message.length<2 || message.length>80)return false;
  if(new RegExp(HARMLESS_QUESTION_EN,"i").test(message) ||
     new RegExp(HARMLESS_QUESTION_ZH,"i").test(message))return true;
  if(mediaKind!=="result" || !/(3\s*d|小颜|小顏)/iu.test(inboundText))return false;
  return [FACE_SHAPE_ZH,FACE_SHAPE_EN,FACE_SHAPE_MS]
    .some(pattern=>new RegExp(pattern,"i").test(message));
}
const HARMLESS_CONTINUATION_SQL=`(
  newer.media_url IS NULL AND newer.media_mime_type IS NULL
  AND CHAR_LENGTH(BTRIM(COALESCE(newer.content,''))) BETWEEN 2 AND 80
  AND (
    BTRIM(newer.content) ~* '${HARMLESS_QUESTION_EN}'
    OR BTRIM(newer.content) ~* '${HARMLESS_QUESTION_ZH}'
    OR (job.media_kind='result'
      AND inbound.content ~* '${FACE_SHAPE_3D_ANCHOR}'
      AND (
        BTRIM(newer.content) ~* '${FACE_SHAPE_ZH}'
        OR BTRIM(newer.content) ~* '${FACE_SHAPE_EN}'
        OR BTRIM(newer.content) ~* '${FACE_SHAPE_MS}'
      ))
  )
)`;


// Already-approved pricing graphics, like result images, survive ordinary
// same-treatment questions during quiet hours. Their original price question
// can be short ("多少钱呢一次"), so compare treatment changes with the
// selected caption rather than the bare inbound text. This predicate is
// shared by READY, STILL_VALID, and pre-send retirement.
const RESULT_MEDIA_SUPERSESSION_SQL=resultSupersessionSql("inbound","newer");
const PROMOTION_MEDIA_SUPERSESSION_SQL=promotionSupersessionSql("job","newer");
const NEWER_CUSTOMER_SUPERSESSION_SQL=`(
  (job.media_kind='result' AND ${RESULT_MEDIA_SUPERSESSION_SQL})
  OR (job.media_kind='promotion' AND ${PROMOTION_MEDIA_SUPERSESSION_SQL})
)`;
const NEWER_MEDIA_PLAN_SQL=`EXISTS(
  SELECT 1 FROM whatsapp_sender_ai_media_jobs successor
  JOIN messages successor_inbound ON successor_inbound.id=successor.inbound_message_id
    AND successor_inbound.contact_id=c.id AND successor_inbound.role='user'
  WHERE successor.sender_id=job.sender_id AND successor.contact_id=job.contact_id
    AND (successor_inbound.created_at,successor_inbound.id)>(inbound.created_at,inbound.id)
    AND (job.media_kind<>'result' OR successor.media_kind='result')
)`;
// Only a newer result-image plan supersedes a prior result. A price graphic
// should not erase a queued Before & After result.

const MAX_ITEMS=5;
const RETRY_MS=90*1000;
const PREPARATION_RETRY_MS=10*60*1000;
const QUEUED_ERROR="Image queued; waiting for the previous WhatsApp send to be verified.";
const CANCELLED_ERROR="Image not sent. The media was superseded, sending was stopped, or its allowed window ended.";

function publishSecondaryMediaStatus(message,env=process.env){
 if(!message?.id || !message?.contact_id)return;
 const scope=configuredVerifiedScope(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
   env.WHATSAPP_SECONDARY_WABA_ID,env);
 if(!scope)return; // Never infer the sender from a bare contact ID.
 try{
   realtimeEvents.publish("conversation_changed",{
     ...scope,contactId:message.contact_id,messageId:message.id,
     deliveryStatus:message.delivery_status,
     deliveryError:message.delivery_error||null,reason:"delivery_status",
   });
 }catch{ /* SSE is best effort after the saved database state. */ }
}
async function reconcileAuditBestEffort(inboundMessageIds,database,env){
 if(!inboundMessageIds?.length)return;
 try{await reconcileSecondaryMediaAudit({inboundMessageIds,database,env});}
 catch(err){console.warn("[Secondary WhatsApp AI media] audit update unavailable:",
   err?.message);}
}
let worker=null;
function enabled(env=process.env){
  return Boolean(secondaryAutomationActivation(env)) &&
    env.WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED==="true" &&
    secondaryUsesPrimaryClinicContent(env) &&
    env.WHATSAPP_SECONDARY_AI_SEND_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED==="true" &&
    (deliveryOnlyEnabled(env)||env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED==="true") &&
    (deliveryOnlyEnabled(env)||env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED==="true") &&
    env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED==="true" &&
    (deliveryOnlyEnabled(env)||env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED==="true") &&
    env.WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED==="true";
}
function validItem(item){
  if(!item || typeof item.imageUrl!=="string" || typeof item.caption!=="string" ||
     item.imageUrl.length>2048 || item.caption.length>1024) return false;
  if(clinicImage.storedClinicImageRef(item.imageUrl))return true;
  try{
    const url=new URL(item.imageUrl);
    return url.protocol==="https:" && Boolean(url.hostname) &&
      !url.username && !url.password;
  }catch{return false;}
}
async function enqueue({
  contactId,inboundMessageId,items,kind="promotion",solicitedPricing=false,sequenceOffset=0,
},{database=pool,env=process.env}={}){
  if(!enabled(env)) return false;
  if(!Number.isSafeInteger(contactId)||contactId<=0||
     !Number.isSafeInteger(inboundMessageId)||inboundMessageId<=0||
     !["promotion","result"].includes(kind)||
     (solicitedPricing === true && kind !== "promotion")||
     !Number.isSafeInteger(sequenceOffset)||sequenceOffset<0||
     !Array.isArray(items)||!items.length||items.length+sequenceOffset>MAX_ITEMS||
     !items.every(validItem))return false;
  if (!await isSecondaryAutomationEligible(contactId, {database,env,inboundMessageId,allowMediaQueueWait:true})) return false;
  const client=await database.connect();
  try{
    await client.query("BEGIN");
    const owner=await client.query(
      `SELECT c.whatsapp_sender_id AS sender_id,inbound.created_at
         FROM contacts c
         JOIN whatsapp_sender_accounts sa ON sa.id=c.whatsapp_sender_id
         JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
           AND sc.contact_id=c.id AND sc.state='bound'
         JOIN messages inbound ON inbound.id=$2 AND inbound.contact_id=c.id
           AND inbound.role='user' AND inbound.whatsapp_message_id IS NOT NULL
         JOIN whatsapp_sender_message_context mc ON mc.message_id=inbound.id
           AND mc.conversation_id=sc.id
        WHERE c.id=$1 AND c.channel='whatsapp' AND c.mode='ai'
          AND ${secondaryAutomationEligibleSql("c","$6","inbound","$7","$8")}
          AND ${secondaryAutomationAttentionAllowedSql("c","inbound",{env,allowMediaQueueWait:true})}
          AND c.whatsapp_opt_out_at IS NULL
          AND c.whatsapp_marketing_opt_out_at IS NULL
          AND sa.state='active' AND sa.sender_key=$3
          AND sa.meta_phone_number_id=$4 AND sa.meta_account_id=$5`,
      [contactId,inboundMessageId,env.WHATSAPP_SECONDARY_SENDER_KEY,
        env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
        secondaryAutomationActivation(env),env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,
         originalAdsOnlyCutoff(env)]
    );
    if(owner.rowCount!==1){await client.query("ROLLBACK");return false;}
    for(let i=0;i<items.length;i++){
      await client.query(
        `INSERT INTO whatsapp_sender_ai_media_jobs
          (sender_id,contact_id,inbound_message_id,sequence_no,
           media_kind,solicited_pricing,image_url,caption,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,
           LEAST($9::timestamptz + INTERVAL '23 hours',
              CASE
                -- The image worker observes clinic quiet hours (00:00-06:59 MYT).
                -- Keep its pending images until after the next permitted 07:00
                -- rather than expiring them at 03:00 without ever attempting a send.
                WHEN EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) >= 21
                  THEN ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')
                    + INTERVAL '1 day 9 hours') AT TIME ZONE 'Asia/Kuala_Lumpur')
                WHEN EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) < 7
                  THEN ((date_trunc('day', NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')
                    + INTERVAL '9 hours') AT TIME ZONE 'Asia/Kuala_Lumpur')
                ELSE NOW() + INTERVAL '3 hours'
              END))
         ON CONFLICT(sender_id,inbound_message_id,sequence_no) DO NOTHING`,
        [owner.rows[0].sender_id,contactId,inboundMessageId,i+sequenceOffset,
          kind,solicitedPricing === true,items[i].imageUrl,items[i].caption,
          owner.rows[0].created_at]
      );
    }
    await client.query("COMMIT");
    // Only signal after the durable commit. The worker runs as soon as newly
    // queued images exist, without needing to wake an empty Neon every minute.
    wake();
    return true;
  }catch(err){await client.query("ROLLBACK").catch(()=>{});throw err;}
  finally{client.release();}
}

// A customer-selected Before & After picture may send overnight only while
// the same signed customer request is fresh. All existing authorization,
// staff, opt-out, clinical, Meta receipt and billing gates still apply.
const RECENT_DIRECT_RESULT_SQL=`(
  job.media_kind='result'
  AND inbound.whatsapp_message_id IS NOT NULL
  AND inbound.created_at BETWEEN NOW()-INTERVAL '2 hours' AND NOW()
  AND job.created_at >= inbound.created_at
  AND job.created_at <= inbound.created_at+INTERVAL '5 minutes'
)`;
function readySql(env=process.env){return `
 SELECT job.*,c.whatsapp_number,c.whatsapp_sender_id,
        sa.sender_key AS whatsapp_sender_key,
        sa.meta_phone_number_id AS whatsapp_sender_phone_number_id,
        sa.meta_account_id AS whatsapp_sender_account_id
 FROM whatsapp_sender_ai_media_jobs job
 JOIN contacts c ON c.id=job.contact_id AND c.whatsapp_sender_id=job.sender_id
 JOIN whatsapp_sender_accounts sa ON sa.id=job.sender_id AND sa.state='active'
 JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
   AND sc.contact_id=c.id AND sc.state='bound'
   AND sc.customer_wa_id=c.whatsapp_number
 JOIN messages inbound ON inbound.id=job.inbound_message_id
   AND inbound.contact_id=c.id AND inbound.role='user'
   AND inbound.whatsapp_message_id IS NOT NULL
 JOIN whatsapp_sender_message_context mc ON mc.message_id=inbound.id
   AND mc.conversation_id=sc.id
 WHERE job.state='pending' AND job.next_attempt_at<=NOW()
   AND (job.preparation_retry_not_before IS NULL OR job.preparation_retry_not_before<=NOW())
   AND ${secondaryAutomationEligibleSql("c","$5","inbound","$6","$7")}
   AND job.expires_at>NOW() AND c.mode='ai' AND ${secondaryAutomationAttentionAllowedSql("c","inbound",{env})}
   AND c.whatsapp_opt_out_at IS NULL
   AND c.whatsapp_marketing_opt_out_at IS NULL
   AND (EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) BETWEEN 7 AND 23
     OR (job.media_kind='promotion' AND job.solicited_pricing=TRUE)
     OR ${RECENT_DIRECT_RESULT_SQL})
   AND sa.sender_key=$1 AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
   AND NOT EXISTS(
     SELECT 1 FROM messages newer WHERE newer.contact_id=c.id
       AND newer.role='user'
       AND (newer.created_at,newer.id)>(inbound.created_at,inbound.id)
       AND ${NEWER_CUSTOMER_SUPERSESSION_SQL}
   )
   AND NOT ${NEWER_MEDIA_PLAN_SQL}
   AND NOT EXISTS(
     SELECT 1 FROM messages staff WHERE staff.contact_id=c.id
       AND staff.role='assistant' AND staff.sent_by_username IS NOT NULL
       AND staff.created_at>=inbound.created_at
   )
   AND NOT EXISTS(
     SELECT 1 FROM whatsapp_sender_ai_media_jobs previous
     WHERE previous.sender_id=job.sender_id
       AND previous.inbound_message_id=job.inbound_message_id
       AND previous.sequence_no<job.sequence_no
       AND previous.state<>'accepted'
       AND NOT (${deliveryOnlySql(env)} AND previous.state='unknown')
   )
 ORDER BY job.created_at,job.contact_id,job.sequence_no
 LIMIT $4
`;}
const READY_SQL=readySql();
function stillValidSql(env=process.env){return `
 SELECT EXISTS(
   SELECT 1 FROM whatsapp_sender_ai_media_jobs job
   JOIN contacts c ON c.id=job.contact_id AND c.whatsapp_sender_id=job.sender_id
   JOIN whatsapp_sender_accounts sa ON sa.id=job.sender_id AND sa.state='active'
   JOIN whatsapp_sender_conversations sc ON sc.sender_id=sa.id
     AND sc.contact_id=c.id AND sc.customer_wa_id=c.whatsapp_number
     AND sc.state='bound'
   JOIN messages inbound ON inbound.id=job.inbound_message_id
     AND inbound.contact_id=c.id AND inbound.role='user'
   WHERE job.id=$1 AND job.state='claimed'
     AND ${secondaryAutomationEligibleSql("c","$5","inbound","$6","$7")}
     AND job.expires_at>NOW() AND c.mode='ai' AND ${secondaryAutomationAttentionAllowedSql("c","inbound",{outboundMessageSql:"job.outbound_message_id",env})}
     AND c.whatsapp_opt_out_at IS NULL
     AND c.whatsapp_marketing_opt_out_at IS NULL
     AND (EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) BETWEEN 7 AND 23
     OR (job.media_kind='promotion' AND job.solicited_pricing=TRUE)
     OR ${RECENT_DIRECT_RESULT_SQL})
     AND sa.sender_key=$2 AND sa.meta_phone_number_id=$3 AND sa.meta_account_id=$4
     AND NOT EXISTS(
       SELECT 1 FROM messages newer WHERE newer.contact_id=c.id
         AND newer.role='user'
         AND (newer.created_at,newer.id)>(inbound.created_at,inbound.id)
         AND ${NEWER_CUSTOMER_SUPERSESSION_SQL}
     )
     AND NOT ${NEWER_MEDIA_PLAN_SQL}
     AND NOT EXISTS(
       SELECT 1 FROM messages human WHERE human.contact_id=c.id
         AND human.role='assistant' AND human.sent_by_username IS NOT NULL
         AND human.created_at>=inbound.created_at
     )
 ) AS allowed
`;}
const STILL_VALID_SQL=stillValidSql();

// A process can die after the one-shot claim but before a provider result.
// Such a claim MUST NOT be replayed: Meta may already have accepted the send.
// Quarantine stale claims for staff reconciliation, scoped to the verified sender.
async function quarantineStaleClaims({
 database=pool,env=process.env,messageRepo=messagesRepo,
}={}){
 if(!enabled(env))return{disabled:true,quarantined:0};
 const stale=await database.query(
   `UPDATE whatsapp_sender_ai_media_jobs AS job
      SET state='unknown',updated_at=NOW()
     FROM whatsapp_sender_accounts AS sender
    WHERE job.sender_id=sender.id AND job.state='claimed'
      AND job.updated_at<NOW()-INTERVAL '30 minutes'
      AND sender.state='active'
      AND sender.sender_key=$1 AND sender.meta_phone_number_id=$2
      AND sender.meta_account_id=$3
    RETURNING job.id,job.outbound_message_id`,
   [env.WHATSAPP_SECONDARY_SENDER_KEY,
     env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]
 );
 for(const job of stale.rows||[]){
   if(job.outbound_message_id){
     // A signed receipt may have settled during a crash. Never overwrite
     // confirmed delivery, only preserve an unresolved staff-visible state.
     try{
       await messageRepo.markDeliveryUnknownIfUnconfirmed(
         job.outbound_message_id,
         "Secondary image worker stopped before the provider outcome was recorded. Verify the actual WhatsApp delivery before any manual resend."
       );
     }catch(err){
       console.error("[Secondary WhatsApp AI media] Could not mark stale image for review:",err?.message);
     }
   }
 }
 return{disabled:false,quarantined:(stale.rows||[]).length};
}


/**
 * Retire ONLY jobs that have never reached a Meta dispatch attempt.
 * Pending jobs are known not to have reached the provider; claimed/unknown
 * attempts must remain quarantined for billing and delivery reconciliation.
 * The message update is guarded by its provider and billing evidence.
 */
async function cancelObsoletePending({database=pool,env=process.env}={}){
 if(!enabled(env))return{disabled:true,cancelled:0};
 const result=await database.query(
   `WITH obsolete AS (
      UPDATE whatsapp_sender_ai_media_jobs AS job
         SET state='expired',updated_at=NOW()
        FROM whatsapp_sender_accounts sa, contacts c, messages inbound
       WHERE job.sender_id=sa.id AND job.contact_id=c.id
         AND c.whatsapp_sender_id=sa.id
         AND inbound.id=job.inbound_message_id
         AND inbound.contact_id=c.id AND inbound.role='user'
         AND job.state='pending'
         AND sa.state='active' AND sa.sender_key=$1
         AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
         AND (
           job.expires_at<=NOW() OR
           c.mode<>'ai' OR NOT (${secondaryAutomationAttentionAllowedSql("c","inbound",{env,allowMediaQueueWait:true})}) OR
           c.whatsapp_opt_out_at IS NOT NULL OR
           c.whatsapp_marketing_opt_out_at IS NOT NULL OR
           NOT (${secondaryAutomationEligibleSql("c","$4","inbound","$6","$7")}) OR
           EXISTS(
             SELECT 1 FROM messages newer WHERE newer.contact_id=c.id
               AND newer.role='user'
               AND (newer.created_at,newer.id)>(inbound.created_at,inbound.id)
               AND ${NEWER_CUSTOMER_SUPERSESSION_SQL}
           ) OR
           ${NEWER_MEDIA_PLAN_SQL} OR
           EXISTS(
             SELECT 1 FROM messages staff WHERE staff.contact_id=c.id
               AND staff.role='assistant' AND staff.sent_by_username IS NOT NULL
               AND staff.created_at>=inbound.created_at
           )
         )
       RETURNING job.inbound_message_id,job.outbound_message_id
    ), cancelled_messages AS (
      UPDATE messages AS m
         SET delivery_status='cancelled', delivery_error=$5
        FROM obsolete j
       WHERE m.id=j.outbound_message_id AND m.role='assistant'
         AND m.whatsapp_message_id IS NULL AND m.whatsapp_accepted_at IS NULL
         AND m.delivery_status IN ('queued','unknown')
         AND NOT EXISTS(
           SELECT 1 FROM whatsapp_sender_billing_attempts a
           WHERE a.message_id=m.id AND a.state<>'rejected'
         )
         AND NOT EXISTS(
           SELECT 1 FROM outbound_message_evidence e
           WHERE e.message_id=m.id AND e.accepted=TRUE
         )
       RETURNING m.id,m.contact_id,m.delivery_status,m.delivery_error
    )
    SELECT (SELECT COUNT(*) FROM obsolete)::int AS retired,
           (SELECT COUNT(*) FROM cancelled_messages)::int AS messages_cancelled,
           (SELECT COALESCE(ARRAY_AGG(DISTINCT inbound_message_id),'{}'::integer[])
              FROM obsolete) AS inbound_ids,
           (SELECT COALESCE(JSON_AGG(ROW_TO_JSON(changed)),'[]'::json)
              FROM cancelled_messages changed) AS changed_messages`,
   [env.WHATSAPP_SECONDARY_SENDER_KEY,
     env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
     secondaryAutomationActivation(env),CANCELLED_ERROR,
     env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,originalAdsOnlyCutoff(env)]
 );
 const row=result.rows?.[0]||{};
 for(const message of (Array.isArray(row.changed_messages)?row.changed_messages:[])){
   publishSecondaryMediaStatus(message,env);
 }
 await reconcileAuditBestEffort(row.inbound_ids||[],database,env);
 return{disabled:false,cancelled:Number(row.retired||0)};
}

// Called only after a signed, sender-scoped Meta receipt has successfully
// reconciled a previous billing reservation. No new send occurs here.
async function wakeAfterVerifiedReconciliation({
 contactIds,database=pool,env=process.env,
}={}){
 const ids=[...new Set((Array.isArray(contactIds)?contactIds:[])
   .map(Number).filter(id=>Number.isSafeInteger(id)&&id>0))];
 // No sender-wide wake. Only the EXACT contact whose signed Meta receipt
 // freed their individual billing gate may advance to a new image.
 // Wake already-due jobs too: otherwise a verified first picture can leave
 // the second picture asleep until the one-minute recovery sweep.
 if(!enabled(env)||!ids.length)return false;
 const pending=await database.query(
   `UPDATE whatsapp_sender_ai_media_jobs AS job
       SET next_attempt_at=NOW(),updated_at=NOW()
      FROM whatsapp_sender_accounts sa
     WHERE job.sender_id=sa.id AND job.state='pending'
       AND job.expires_at>NOW()
       AND sa.state='active' AND sa.sender_key=$1
       AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
       AND job.contact_id=ANY($4::int[])
       -- Ordinary queued images may wake immediately, but a preparation
       -- retry has its own durable minimum delay, independent of receipts.
       AND (job.preparation_retry_not_before IS NULL OR job.preparation_retry_not_before<=NOW())
       AND (${deliveryOnlySql(env)} OR EXISTS(
         SELECT 1 FROM whatsapp_sender_billing_gates gate
         WHERE gate.sender_id=sa.id AND gate.owner_contact_id=job.contact_id
         -- Final billing reservation validates idle or strict aged UNKNOWN
         -- new-send proof. Do not silently suppress qualified media here.
       ))
     RETURNING job.id`,
   [env.WHATSAPP_SECONDARY_SENDER_KEY,
     env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,ids]
 );
 if(pending.rowCount>0)wake();
 return pending.rowCount>0;
}

async function runOnce({
 database=pool,env=process.env,
 contacts=contactsRepo,store=conversationStore,
 send=sendSecondaryStaffText,policy=secondaryPolicy,
 messageRepo=messagesRepo,loadClinicImage=clinicImage.loadOwnedClinicImage,
 getConfig=()=>configRepo.getConfig(),
 isAuthorizedImage=mediaApproval.isCurrentApprovedClinicImage,
 limit=5,
}={}){
 if(!enabled(env))return{disabled:true,accepted:0,pending:0};
 await quarantineStaleClaims({database,env,messageRepo});
 await cancelObsoletePending({database,env});
 const list=await database.query(readySql(env),[
   env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
   Math.max(1,Math.min(10,Number(limit)||5)),
   secondaryAutomationActivation(env),
   env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,originalAdsOnlyCutoff(env),
 ]);
 let accepted=0,pending=0;
 const changedInbounds=new Set();
 for(const job of list.rows||[]){
   // Atomic one-shot claim; a crash after claim is UNKNOWN, never replayed.
   const claimed=await database.query(
     "UPDATE whatsapp_sender_ai_media_jobs SET state='claimed',preparation_retry_not_before=NULL,updated_at=NOW() WHERE id=$1 AND state='pending' AND next_attempt_at<=NOW() AND (preparation_retry_not_before IS NULL OR preparation_retry_not_before<=NOW()) RETURNING id",
     [job.id]
   );
   if(claimed.rowCount!==1)continue;
   changedInbounds.add(job.inbound_message_id);
   const update=async(state)=>{
     const saved=await database.query(
       "UPDATE whatsapp_sender_ai_media_jobs SET state=$2,updated_at=NOW() WHERE id=$1 AND state='claimed' RETURNING outbound_message_id",
       [job.id,state]
     );
     // Never imply a picture reached WhatsApp when Meta acceptance is unknown.
     // Only modify an unconfirmed assistant row; signed receipts remain authoritative.
     const id=saved.rows?.[0]?.outbound_message_id;
     if(id && state!=="accepted"){
       if(state==="expired"){
         // An expired pre-send claim cannot be treated as a Meta attempt.
         // Cancel only if no reservation, WAMID or provider evidence exists.
         const cancelled=await database.query(
           `UPDATE messages AS m
               SET delivery_status='cancelled',delivery_error=$2
             WHERE m.id=$1 AND m.role='assistant'
               AND m.whatsapp_message_id IS NULL
               AND m.whatsapp_accepted_at IS NULL
               AND m.delivery_status IN ('queued','unknown')
               AND NOT EXISTS(
                 SELECT 1 FROM whatsapp_sender_billing_attempts a
                 WHERE a.message_id=m.id AND a.state<>'rejected')
               AND NOT EXISTS(
                 SELECT 1 FROM outbound_message_evidence e
                 WHERE e.message_id=m.id AND e.accepted=TRUE)
             RETURNING m.id,m.contact_id,m.delivery_status,m.delivery_error`,
           [id,CANCELLED_ERROR]
         );
         if(cancelled.rows?.[0]){
           publishSecondaryMediaStatus(cancelled.rows[0],env);
           return saved;
         }
       }
       // If a prior provider or billing attempt exists, preserve uncertain
       // delivery for human reconciliation rather than declare it unsent.
       const changed=await messageRepo.markDeliveryUnknownIfUnconfirmed(id,
         "Secondary image delivery is uncertain; manually verify before resending.");
       if(changed?.marked)publishSecondaryMediaStatus(changed.message,env);
     }
     return saved;
   };
   try{
     const contact=await contacts.getContactById(job.contact_id);
     if(contact?.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
        String(contact.whatsapp_sender_id)!==String(job.sender_id) ||
        contact.whatsapp_number!==job.whatsapp_number){
       await update("unknown");continue;
     }
     // A customer can request English while a Chinese image is waiting for
     // billing, quiet hours or the previous message receipt. Re-select the
     // configured artwork at dispatch time, never send stale-language media.
     const requestedLanguage=await latestQueuedLanguagePreference(
       database,job.contact_id,job.inbound_message_id);
     const media=resolveQueuedMediaLanguage({
       imageUrl:job.image_url,caption:job.caption,kind:job.media_kind,
       language:requestedLanguage,config:getConfig(),
     });
     if(!media){await update("expired");continue;}
     const currentLanguageSelection=()=>queuedMediaLanguageStillCurrent({
       database,contactId:job.contact_id,inboundMessageId:job.inbound_message_id,
       imageUrl:job.image_url,caption:job.caption,kind:job.media_kind,
       selectedMedia:media,getConfig,
     });
     const cancelledBeforeProvider=(code)=>({
       success:false,preProviderCancelled:true,retryable:false,code,
     });
     const languageChangedBeforeProvider=()=>cancelledBeforeProvider("secondary_ai_media_language_changed");
     const preparationFailed=(stage,temporary)=>{
       // No recipient, token, URL, image bytes or message content in logs.
       console.warn("[Secondary AI media preparation]",JSON.stringify({
         jobId:job.id,stage,temporary,
       }));
       return cancelledBeforeProvider(temporary
         ?"secondary_ai_media_preparation_retryable"
         :"secondary_ai_media_preparation_failed");
     };
     const policyCancelled=()=>cancelledBeforeProvider("secondary_ai_media_cancelled_before_provider");
     const preSendCheck=async()=>{
       const check=await database.query(stillValidSql(env),[
         job.id,env.WHATSAPP_SECONDARY_SENDER_KEY,
         env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
         secondaryAutomationActivation(env),
         env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,originalAdsOnlyCutoff(env),
       ]);
       if(check.rows?.[0]?.allowed!==true)return false;
       const current=await contacts.getContactById(job.contact_id);
       if(current?.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
          current.mode!=="ai" ||
          !(await contacts.canSendAutomaticReviewMedia(current.id,{database,env})))return false;
       const preview=await policy.previewSecondaryFreeformPolicy(current,{
         database,env,now:new Date(),purpose:"service",
       });
       return preview?.policyAllowed===true;
     };
     // The operator can revoke an image after the inbound AI selected it.
     // Revalidate source config before an outbound row or billing claim exists.
     const imageApproved=()=>{
       try{return isAuthorizedImage({
         imageUrl:job.image_url,kind:job.media_kind,config:getConfig(),
         now:new Date(),
       })===true && isAuthorizedImage({
         imageUrl:media.imageUrl,kind:job.media_kind,config:getConfig(),
         now:new Date(),
       })===true;}catch{return false;}
     };
     if(!imageApproved() || !await preSendCheck()){
       await update("expired");continue;
     }
     let messageId=job.outbound_message_id;
     if(!messageId){
       const saved=await store.appendMessageForContact(
         contact.id,"assistant",media.caption,null,null,media.imageUrl,null,
         {publish:false,
          whatsappTemplate:{automatedSecondaryAiMedia:true,
            senderKey:env.WHATSAPP_SECONDARY_SENDER_KEY,
            anchorMessageId:job.inbound_message_id},
          initialDeliveryStatus:"queued",
          initialDeliveryError:QUEUED_ERROR}
       );
       messageId=saved.id;
       await database.query(
         "UPDATE whatsapp_sender_ai_media_jobs SET outbound_message_id=$2 WHERE id=$1 AND state='claimed'",
         [job.id,messageId]
       );
       publishSecondaryMediaStatus({
         id:messageId,contact_id:contact.id,delivery_status:"queued",
         delivery_error:QUEUED_ERROR,
       },env);
     }
     // A claimed send may reach Meta. From this point until signed provider
     // proof is stored, present an uncertain outcome rather than "queued".
     await database.query(
       "UPDATE messages SET delivery_status='unknown',delivery_error=$2 " +
       "WHERE id=$1 AND role='assistant' AND delivery_status='queued' " +
       "AND whatsapp_message_id IS NULL AND whatsapp_accepted_at IS NULL",
       [messageId,"Secondary image send started; Meta acceptance not confirmed."]
     );
     const result=await send({
       contact,messageId,text:media.caption||"[automatic image]",
       origin:"ai_media",preSendCheck,anchorMessageId:job.inbound_message_id,
       dispatchTransport:async(transport)=>{
         let customerSendStarted=false;
         try {
         if(!imageApproved() || !await preSendCheck())
           return policyCancelled();
         // This callback runs after the sender's final billing reservation
         // checks. A new language request proves no image SEND has occurred.
         if(!await currentLanguageSelection())
           return languageChangedBeforeProvider();
         if(clinicImage.storedClinicImageRef(media.imageUrl)){
           // Never pass a private before/after preview URL to Meta.
           // Download only a matching-purpose configured image from Neon,
           // then upload it using the SECONDARY phone's Graph transport.
           let image,uploaded;
           try{image=await loadClinicImage(media.imageUrl);}
           catch{return preparationFailed("load_exception",true);}
           if(!image)return preparationFailed("missing_or_invalid_image",false);
           try{uploaded=await transport.uploadMedia(image.buffer,image.mimeType,image.filename);}
           catch{return preparationFailed("upload_exception",true);}
           // /media uploads cannot deliver a customer message, even if the
           // upload response is uncertain. No /messages call has occurred.
           if(!uploaded?.success || !/^[0-9]+$/.test(String(uploaded.mediaId||""))){
             const status=Number(uploaded?.providerStatus);
             const permanent=uploaded?.definitivelyRejected===true &&
               status>=400 && status<500 && ![408,429].includes(status);
             return preparationFailed("upload_failed",!permanent);
           }
           if(!imageApproved() || !await preSendCheck())
             return policyCancelled();
           // Uploading image bytes is not a WhatsApp message send. The
           // customer may switch languages while those bytes upload.
           if(!await currentLanguageSelection())
             return languageChangedBeforeProvider();
           customerSendStarted=true;
           return await transport.sendMediaById("image",uploaded.mediaId,{caption:media.caption});
         }
         if(!imageApproved() || !await preSendCheck())
           return policyCancelled();
         if(!await currentLanguageSelection())
           return languageChangedBeforeProvider();
         customerSendStarted=true;
         return await transport.sendImageByUrl(media.imageUrl,media.caption);
         } catch (err) {
           if(!customerSendStarted)return preparationFailed("pre_send_check_exception",true);
           throw err;
         }
       },
     },{env,database});
     if(result?.success===true && result?.unknown!==true &&
        /^wamid\./.test(String(result.wamid||""))){
       await messageRepo.setWhatsappMessageId(messageId,result.wamid,{
         preserveVerifiedSecondaryReceipt:true,
       });
       await database.query(
         "UPDATE whatsapp_sender_ai_media_jobs SET state='accepted',accepted_wamid=$2,updated_at=NOW() WHERE id=$1 AND state='claimed'",
         [job.id,result.wamid]
       );
       accepted++;
       // A signed receipt can clear the sender gate while this image is still
       // 'claimed'. Wake again AFTER recording 'accepted' to close that race.
       // A wake error cannot change a verified Meta-send outcome.
       try{
         await wakeAfterVerifiedReconciliation({contactIds:[job.contact_id],database,env});
       }catch(err){
         console.warn("[Secondary WhatsApp AI media] post-acceptance wake unavailable:",
           err?.message);
       }
     }else if(result?.preProviderCancelled===true &&
              result?.code==="secondary_ai_media_preparation_retryable" &&
              result?.success===false && result?.unknown!==true && result?.ambiguous!==true && !result?.wamid){
       // The original reservation must be durably rejected. Retire the old
       // draft and requeue the job atomically; a future claim uses a NEW message
       // id and still passes all sender, language, expiry and policy checks.
       const deferred=await database.query(`
         WITH eligible AS MATERIALIZED (
           SELECT j.id,m.id AS message_id FROM whatsapp_sender_ai_media_jobs j
           JOIN messages m ON m.id=j.outbound_message_id AND m.contact_id=j.contact_id
           WHERE j.id=$1 AND j.state='claimed' AND m.id=$2
             AND m.role='assistant' AND m.delivery_status='unknown'
             AND m.whatsapp_message_id IS NULL AND m.whatsapp_accepted_at IS NULL
             AND EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts b
               WHERE b.message_id=m.id AND b.sender_id=j.sender_id AND b.contact_id=j.contact_id
                 AND b.state='rejected' AND b.wamid IS NULL)
             AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_billing_attempts b
               WHERE b.message_id=m.id AND (b.state<>'rejected' OR b.wamid IS NOT NULL))
             AND NOT EXISTS(SELECT 1 FROM whatsapp_sender_status_receipts r
               JOIN whatsapp_sender_billing_attempts b ON b.reservation_id=r.reservation_id
               WHERE b.message_id=m.id)
             AND NOT EXISTS(SELECT 1 FROM outbound_message_evidence e WHERE e.message_id=m.id)
           FOR UPDATE OF j,m
         ), cancelled AS (
           UPDATE messages m SET delivery_status='cancelled',delivery_error=$4
           FROM eligible e WHERE m.id=e.message_id
           RETURNING m.id,m.contact_id,m.delivery_status,m.delivery_error
         ), requeued AS (
           UPDATE whatsapp_sender_ai_media_jobs j
           SET state='pending',outbound_message_id=NULL,
               next_attempt_at=NOW()+($3::int*INTERVAL '1 millisecond'),
               preparation_retry_not_before=NOW()+($3::int*INTERVAL '1 millisecond'),updated_at=NOW()
           FROM eligible e WHERE j.id=e.id AND EXISTS(SELECT 1 FROM cancelled)
           RETURNING j.id
         )
         SELECT cancelled.* FROM cancelled WHERE EXISTS(SELECT 1 FROM requeued)`,
         [job.id,messageId,PREPARATION_RETRY_MS,"Image preparation temporarily failed before WhatsApp send; a new attempt may be scheduled." ]);
       if(deferred.rows?.[0]){
         publishSecondaryMediaStatus(deferred.rows[0],env);
         pending++;
       }else await update("unknown");
     }else if(result?.preProviderCancelled===true &&
              !(result.noReservation===true && result.code==="secondary_pre_provider_preflight_exception") &&
              result?.success===false && result?.unknown!==true && result?.ambiguous!==true && !result?.wamid){
       // Reservation was definitively rejected with proof that no WhatsApp
       // image send occurred. Do not leave a false unknown-send billing hold.
       await update("expired");
     }else if(["secondary_staff_billing_blocked","secondary_billing_previous_send_unresolved",
       "secondary_billing_sender_alarm","secondary_billing_unknown_hold_not_reviewed","secondary_pre_provider_preflight_exception"].includes(result?.code) && !result?.unknown && !result?.ambiguous && !result?.wamid && result?.policyBlocked===true && (result.code!=="secondary_pre_provider_preflight_exception" || result.noReservation===true)){
       // No provider call or billable reservation occurred. Safe to defer.
       // This documented billing block happened before any provider attempt.
       // Keep an accurate queued badge, rather than an ambiguous send warning.
       await database.query(
         `WITH deferred AS (
            UPDATE whatsapp_sender_ai_media_jobs
               SET state='pending',
                   next_attempt_at=NOW()+($2::int * INTERVAL '1 millisecond'),
                   preparation_retry_not_before=CASE WHEN $4::boolean THEN NOW()+($2::int*INTERVAL '1 millisecond') ELSE NULL END,
                   updated_at=NOW()
             WHERE id=$1 AND state='claimed'
             RETURNING outbound_message_id
          )
          UPDATE messages AS m SET delivery_status='queued',delivery_error=$3
          FROM deferred d
          WHERE m.id=d.outbound_message_id AND m.role='assistant'
            AND m.whatsapp_message_id IS NULL AND m.whatsapp_accepted_at IS NULL
            AND m.delivery_status IN ('unknown','queued')
            AND NOT EXISTS(
              SELECT 1 FROM whatsapp_sender_billing_attempts a
              WHERE a.message_id=m.id AND a.state<>'rejected'
            )`,
         [job.id,result.code==="secondary_pre_provider_preflight_exception"?PREPARATION_RETRY_MS:RETRY_MS,QUEUED_ERROR,result.code==="secondary_pre_provider_preflight_exception"]
       );
       pending++;
     }else await update("unknown");
   }catch(err){
     await update("unknown").catch(()=>{});
     console.error("[Secondary WhatsApp AI media] Uncertain outcome requires manual review:",err?.message);
   }
 }
 await reconcileAuditBestEffort([...changedInbounds],database,env);
 return{disabled:false,accepted,pending};
}
// A claimed job may be midway through a Meta send, or have a presently
// unknown provider outcome after a crash. Continue the existing one-minute
// recovery cadence until it is accepted or safely quarantined.
const PENDING_SQL=`SELECT EXISTS(
  SELECT 1 FROM whatsapp_sender_ai_media_jobs job
  JOIN whatsapp_sender_accounts sender ON sender.id=job.sender_id
  WHERE sender.sender_key=$1 AND sender.meta_phone_number_id=$2
    AND sender.meta_account_id=$3 AND sender.state='active'
    AND job.state IN ('pending','claimed')
) AS has_work`;
async function hasPendingWork({database=pool,env=process.env}={}){
 if(!enabled(env))return false;
 const result=await database.query(PENDING_SQL,[
   env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
   env.WHATSAPP_SECONDARY_WABA_ID,
 ]);
 const pending=result.rows?.[0]?.has_work;
 if(typeof pending!=="boolean")
   throw Error("Recovery queue status unavailable; retry shortly");
 return pending;
}
// A deferred image must not keep Neon awake once per minute just because its
// durable state is "pending". Claimed attempts still need the original
// one-minute crash/billing recovery; pending retries wake at their actual due
// time (and no later than the hourly orphan-job safety sweep).
const MEDIA_ACTIVE_CHECK_MS=60*1000;
const MEDIA_IDLE_CHECK_MS=60*60*1000;
const MALAYSIA_UTC_OFFSET_MS=8*60*60*1000;
const RECOVERY_DEADLINE_SQL=`
 SELECT COALESCE(BOOL_OR(job.state='claimed'),FALSE) AS has_claimed,
        COALESCE(BOOL_OR(job.state='pending' AND job.expires_at>NOW()),FALSE)
          AS has_pending,
        COALESCE(BOOL_OR(job.state='pending' AND job.expires_at>NOW()
          AND job.media_kind='promotion' AND job.solicited_pricing=TRUE),FALSE)
          AS has_solicited_pending,
        MIN(job.next_attempt_at) FILTER(
          WHERE job.state='pending' AND job.expires_at>NOW()
            AND job.media_kind='promotion' AND job.solicited_pricing=TRUE
        ) AS next_solicited_at,
        COALESCE(BOOL_OR(job.state='pending' AND job.expires_at>NOW()
          AND job.media_kind='result' AND inbound.whatsapp_message_id IS NOT NULL
          AND inbound.created_at BETWEEN NOW()-INTERVAL '2 hours' AND NOW()
          AND job.created_at BETWEEN inbound.created_at
            AND inbound.created_at+INTERVAL '5 minutes'),FALSE)
          AS has_direct_result_pending,
        MIN(job.next_attempt_at) FILTER(
          WHERE job.state='pending' AND job.expires_at>NOW()
            AND job.media_kind='result' AND inbound.whatsapp_message_id IS NOT NULL
            AND inbound.created_at BETWEEN NOW()-INTERVAL '2 hours' AND NOW()
            AND job.created_at BETWEEN inbound.created_at
              AND inbound.created_at+INTERVAL '5 minutes'
        ) AS next_direct_result_at,
        MIN(job.next_attempt_at) FILTER(
          WHERE job.state='pending' AND job.expires_at>NOW()
        ) AS next_pending_at
 FROM whatsapp_sender_ai_media_jobs job
 JOIN whatsapp_sender_accounts sender ON sender.id=job.sender_id
 LEFT JOIN messages inbound ON inbound.id=job.inbound_message_id
   AND inbound.contact_id=job.contact_id AND inbound.role='user'
 WHERE sender.sender_key=$1 AND sender.meta_phone_number_id=$2
   AND sender.meta_account_id=$3 AND sender.state='active'
   AND job.state IN ('pending','claimed')
`;
function nextMediaRecoveryDelay(state,nowMs=Date.now()){
 if(!Number.isFinite(nowMs) || typeof state?.has_claimed!=="boolean" ||
    typeof state?.has_pending!=="boolean")
   throw Error("Media recovery deadline unavailable; retry shortly");
 // Keep minute-level quarantine and billing reconciliation for claimed sends.
 if(state.has_claimed)return MEDIA_ACTIVE_CHECK_MS;
 if(!state.has_pending)return alignedIdleRecoveryDelay(MEDIA_IDLE_CHECK_MS,nowMs,process.env,"Secondary WhatsApp AI media recovery");
 const nextAt=new Date(state.next_pending_at).getTime();
 if(state.next_pending_at==null || !Number.isFinite(nextAt))
   throw Error("Pending media retry deadline unavailable; retry shortly");
 const shifted=new Date(nowMs+MALAYSIA_UTC_OFFSET_MS);
 if(shifted.getUTCHours()<7){
   // Only independently customer-requested, recent result pictures and
   // solicited price graphics may bypass the ordinary nighttime pause.
   // A short due retry never authorizes an expired or unrelated image: READY
   // and STILL_VALID independently recheck the signed inbound and all gates.
   const due=[];
   if(state.has_solicited_pending===true){
     const requestedAt=new Date(state.next_solicited_at).getTime();
     if(state.next_solicited_at==null || !Number.isFinite(requestedAt))
       throw Error("Solicited pricing media deadline unavailable; retry shortly");
     due.push(requestedAt);
   }
   if(state.has_direct_result_pending===true){
     const resultAt=new Date(state.next_direct_result_at).getTime();
     if(state.next_direct_result_at==null || !Number.isFinite(resultAt))
       throw Error("Verified direct result media deadline unavailable; retry shortly");
     due.push(resultAt);
   }
   if(due.length)return Math.min(MEDIA_IDLE_CHECK_MS,
     Math.max(MEDIA_ACTIVE_CHECK_MS,Math.min(...due)-nowMs));
   const opening=Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),
     shifted.getUTCDate(),7)-MALAYSIA_UTC_OFFSET_MS;
   // Other pending sends remain paused during quiet hours. Wake at 07:00
   // or for the existing hourly orphan recovery, whichever comes first.
   return Math.max(1000,Math.min(MEDIA_IDLE_CHECK_MS,opening-nowMs));
 }
 // Preserve immediate enqueue/receipt wakes and due retries during allowed
 // hours. When a job is blocked despite being due, retain the minute backstop.
 return Math.min(MEDIA_IDLE_CHECK_MS,
   Math.max(MEDIA_ACTIVE_CHECK_MS,nextAt-nowMs));
}
async function readMediaRecoveryDelay({database=pool,env=process.env,nowMs=Date.now()}={}){
 if(!enabled(env))return MEDIA_IDLE_CHECK_MS;
 const result=await database.query(RECOVERY_DEADLINE_SQL,[
   env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
   env.WHATSAPP_SECONDARY_WABA_ID,
 ]);
 return nextMediaRecoveryDelay(result.rows?.[0],nowMs);
}

function wake(){return worker?.wake(0)===true;}
function start({env=process.env,run=runOnce,database=pool,...clock}={}){
 if(!enabled(env)||worker)return false;
 let historicalAuditPending=true;
 worker=createAdaptiveWorkerTimer({
   ...clock,
   label:"Secondary WhatsApp AI media recovery",
   errorRetryDelayMs:MEDIA_ACTIVE_CHECK_MS,
   run:async()=>{
     await run({env,database});
     if(historicalAuditPending){
       try{
         await reconcileRecentTerminalMediaAudit({database,env});
         historicalAuditPending=false;
       }catch(err){
         console.warn("[Secondary WhatsApp AI media] old audit repair unavailable:",
           err?.message);
       }
     }
     return {nextDelayMs:await readMediaRecoveryDelay({
       env,database,nowMs:(clock.now||Date.now)(),
     })};
   },
   delayForResult:result=>result.nextDelayMs,
 });
 worker.start(0);
 return true;
}
function stop(){if(worker){worker.stop();worker=null;}}
module.exports={enabled,enqueue,READY_SQL,STILL_VALID_SQL,PENDING_SQL,
 RECOVERY_DEADLINE_SQL,RECENT_DIRECT_RESULT_SQL,nextMediaRecoveryDelay,readMediaRecoveryDelay,HARMLESS_CONTINUATION_SQL,PROMOTION_MEDIA_SUPERSESSION_SQL,NEWER_MEDIA_PLAN_SQL,isHarmlessContinuationQuestion,quarantineStaleClaims,cancelObsoletePending,wakeAfterVerifiedReconciliation,runOnce,hasPendingWork,start,wake,stop};
