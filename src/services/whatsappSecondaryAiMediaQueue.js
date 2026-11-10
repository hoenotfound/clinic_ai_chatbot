"use strict";

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
const configRepo=require("../db/configRepo");
const {createIdleAwareRecoveryWorker}=require("../utils/idleAwareRecoveryWorker");
const realtimeEvents=require("../utils/realtimeEvents");
const {configuredVerifiedScope}=require("../utils/verifiedWhatsAppEventScope");
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


// Block explicit stop requests even if the contact opt-out update is pending.
const EXPLICIT_STOP_SQL="BTRIM(COALESCE(newer.content,'')) ~* '(^|[[:space:]])(stop|unsubscribe|opt[ -]?out)([[:space:][:punct:]]|$)|不要再发|停止发送|停止推送|别再发|不要再联系|jangan hantar|jangan mesej'";
const NEWER_CUSTOMER_SUPERSESSION_SQL=`(
  (job.media_kind='result' AND ${EXPLICIT_STOP_SQL})
  OR (job.media_kind<>'result' AND NOT ${HARMLESS_CONTINUATION_SQL})
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
    env.WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED==="true" &&
    env.WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED==="true" &&
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
  contactId,inboundMessageId,items,kind="promotion",sequenceOffset=0,
},{database=pool,env=process.env}={}){
  if(!enabled(env)) return false;
  if(!Number.isSafeInteger(contactId)||contactId<=0||
     !Number.isSafeInteger(inboundMessageId)||inboundMessageId<=0||
     !["promotion","result"].includes(kind)||
     !Number.isSafeInteger(sequenceOffset)||sequenceOffset<0||
     !Array.isArray(items)||!items.length||items.length+sequenceOffset>MAX_ITEMS||
     !items.every(validItem))return false;
  if (!await isSecondaryAutomationEligible(contactId, {database,env,inboundMessageId})) return false;
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
          AND ${secondaryAutomationAttentionAllowedSql("c")}
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
           media_kind,image_url,caption,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,
           LEAST($8::timestamptz + INTERVAL '23 hours',
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
          kind,items[i].imageUrl,items[i].caption,owner.rows[0].created_at]
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

const READY_SQL=`
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
   AND ${secondaryAutomationEligibleSql("c","$5","inbound","$6","$7")}
   AND job.expires_at>NOW() AND c.mode='ai' AND ${secondaryAutomationAttentionAllowedSql("c")}
   AND c.whatsapp_opt_out_at IS NULL
   AND c.whatsapp_marketing_opt_out_at IS NULL
   AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) BETWEEN 7 AND 23
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
   )
 ORDER BY job.created_at,job.contact_id,job.sequence_no
 LIMIT $4
`;
const STILL_VALID_SQL=`
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
     AND job.expires_at>NOW() AND c.mode='ai' AND ${secondaryAutomationAttentionAllowedSql("c")}
     AND c.whatsapp_opt_out_at IS NULL
     AND c.whatsapp_marketing_opt_out_at IS NULL
     AND EXTRACT(HOUR FROM (NOW() AT TIME ZONE 'Asia/Kuala_Lumpur')) BETWEEN 7 AND 23
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
`;

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
           c.mode<>'ai' OR NOT (${secondaryAutomationAttentionAllowedSql("c")}) OR
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
       AND EXISTS(
         SELECT 1 FROM whatsapp_sender_billing_gates gate
         WHERE gate.sender_id=sa.id AND gate.owner_contact_id=job.contact_id
           AND gate.state='idle'
       )
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
 const list=await database.query(READY_SQL,[
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
     "UPDATE whatsapp_sender_ai_media_jobs SET state='claimed',updated_at=NOW() WHERE id=$1 AND state='pending' RETURNING id",
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
     const preSendCheck=async()=>{
       const check=await database.query(STILL_VALID_SQL,[
         job.id,env.WHATSAPP_SECONDARY_SENDER_KEY,
         env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
         secondaryAutomationActivation(env),
         env.WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE,originalAdsOnlyCutoff(env),
       ]);
       if(check.rows?.[0]?.allowed!==true)return false;
       const current=await contacts.getContactById(job.contact_id);
       if(current?.whatsapp_sender_key!==env.WHATSAPP_SECONDARY_SENDER_KEY ||
          current.mode!=="ai" ||
          !(await contacts.canSendAutomaticReviewMedia(current.id)))return false;
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
       })===true;}catch{return false;}
     };
     if(!imageApproved() || !await preSendCheck()){
       await update("expired");continue;
     }
     let messageId=job.outbound_message_id;
     if(!messageId){
       const saved=await store.appendMessageForContact(
         contact.id,"assistant",job.caption,null,null,job.image_url,null,
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
       contact,messageId,text:job.caption||"[automatic image]",
       origin:"ai_media",preSendCheck,anchorMessageId:job.inbound_message_id,
       dispatchTransport:async(transport)=>{
         if(!imageApproved() || !await preSendCheck())
           return {success:false,unknown:true,ambiguous:true,retryable:false};
         if(clinicImage.storedClinicImageRef(job.image_url)){
           // Never pass a private before/after preview URL to Meta.
           // Download only a matching-purpose configured image from Neon,
           // then upload it using the SECONDARY phone's Graph transport.
           const image=await loadClinicImage(job.image_url);
           if(!image)return {success:false,unknown:true,ambiguous:true,retryable:false};
           const uploaded=await transport.uploadMedia(
             image.buffer,image.mimeType,image.filename);
           if(!uploaded?.success || !/^[0-9]+$/.test(String(uploaded.mediaId||"")))
             return {success:false,unknown:true,ambiguous:true,retryable:false};
           if(!imageApproved() || !await preSendCheck())
             return {success:false,unknown:true,ambiguous:true,retryable:false};
           return transport.sendMediaById("image",uploaded.mediaId,{caption:job.caption});
         }
         if(!imageApproved() || !await preSendCheck())
           return {success:false,unknown:true,ambiguous:true,retryable:false};
         return transport.sendImageByUrl(job.image_url,job.caption);
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
     }else if(["secondary_staff_billing_blocked","secondary_billing_previous_send_unresolved",
       "secondary_billing_sender_alarm"].includes(result?.code) && !result?.unknown){
       // No provider call or billable reservation occurred. Safe to defer.
       // This documented billing block happened before any provider attempt.
       // Keep an accurate queued badge, rather than an ambiguous send warning.
       await database.query(
         `WITH deferred AS (
            UPDATE whatsapp_sender_ai_media_jobs
               SET state='pending',
                   next_attempt_at=NOW()+($2::int * INTERVAL '1 millisecond'),
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
         [job.id,RETRY_MS,QUEUED_ERROR]
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
function wake(){return worker?.wake(0)===true;}
function start({env=process.env,run=runOnce,database=pool,...clock}={}){
 if(!enabled(env)||worker)return false;
 let historicalAuditPending=true;
 worker=createIdleAwareRecoveryWorker({
   ...clock,
   label:"Secondary WhatsApp AI media recovery",
   run:async()=>{
     const result=await run({env,database});
     if(historicalAuditPending){
       try{
         await reconcileRecentTerminalMediaAudit({database,env});
         historicalAuditPending=false;
       }catch(err){
         console.warn("[Secondary WhatsApp AI media] old audit repair unavailable:",
           err?.message);
       }
     }
     return result;
   },
   hasPendingWork:()=>hasPendingWork({env,database}),
 });
 worker.start(0);
 return true;
}
function stop(){if(worker){worker.stop();worker=null;}}
module.exports={enabled,enqueue,READY_SQL,STILL_VALID_SQL,PENDING_SQL,HARMLESS_CONTINUATION_SQL,NEWER_MEDIA_PLAN_SQL,isHarmlessContinuationQuestion,quarantineStaleClaims,cancelObsoletePending,wakeAfterVerifiedReconciliation,runOnce,hasPendingWork,start,wake,stop};
