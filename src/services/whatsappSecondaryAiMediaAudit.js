"use strict";

// Secondary-only, staff-facing picture audit. A Meta HTTP WAMID is not a
// delivered picture: only signed delivered/read status is counted as sent.
// This is never an outbound pathway, and it does not touch the primary queue.
const {pool}=require("../db/db");
const {secondaryAutomationActivation}=require("./whatsappSecondaryAdsOnlyEligibility");

const RECONCILE_SQL=`
 WITH totals AS (
   SELECT j.contact_id,j.inbound_message_id,
     COUNT(*)::int AS image_total,
     COUNT(*) FILTER(WHERE j.media_kind='result')::int AS result_total,
     COUNT(*) FILTER(WHERE j.media_kind='result' AND j.state='accepted'
       AND m.delivery_status IN('delivered','read'))::int AS result_confirmed,
     COUNT(*) FILTER(WHERE j.media_kind='promotion' AND j.state='accepted'
       AND m.delivery_status IN('delivered','read'))::int AS promo_confirmed,
     COUNT(*) FILTER(WHERE j.state='accepted'
       AND m.delivery_status IN('delivered','read'))::int AS confirmed,
     COUNT(*) FILTER(WHERE j.state IN('pending','claimed'))::int AS pending,
     COUNT(*) FILTER(WHERE j.state='unknown'
       OR (j.state='expired' AND m.delivery_status='unknown')
       OR (j.state='accepted' AND m.delivery_status='unknown'))::int AS uncertain,
     COUNT(*) FILTER(WHERE j.state='accepted' AND
       (m.delivery_status IS NULL OR m.delivery_status IN('queued','sent','pending')))::int AS awaiting_receipt,
     COUNT(*) FILTER(WHERE j.state='accepted' AND m.delivery_status='failed')::int AS failed
   FROM whatsapp_sender_ai_media_jobs j
   JOIN whatsapp_sender_accounts sa ON sa.id=j.sender_id
   LEFT JOIN messages m ON m.id=j.outbound_message_id AND m.contact_id=j.contact_id
   WHERE j.inbound_message_id=ANY($1::int[])
     AND sa.state='active' AND sa.sender_key=$2
     AND sa.meta_phone_number_id=$3 AND sa.meta_account_id=$4
   GROUP BY j.contact_id,j.inbound_message_id
 ), outcome AS (
   SELECT totals.*,
     CASE WHEN pending>0 OR uncertain>0 OR awaiting_receipt>0 THEN 'deferred'
       WHEN confirmed=image_total THEN 'sent'
       WHEN confirmed>0 THEN 'partial'
       WHEN failed>0 THEN 'failed'
       ELSE 'skipped' END AS new_status,
     CASE WHEN uncertain>0 THEN 'secondary_media_outcome_unconfirmed'
       WHEN pending>0 THEN 'awaiting_sender_billing_receipt'
       WHEN awaiting_receipt>0 THEN 'secondary_media_waiting_delivery_receipt'
       WHEN confirmed=image_total THEN 'secondary_media_delivered'
       WHEN confirmed>0 THEN 'secondary_media_partial'
       WHEN failed>0 THEN 'secondary_media_delivery_failed'
       ELSE 'secondary_media_cancelled_before_send' END AS new_reason
   FROM totals
 )
 INSERT INTO result_media_decisions
   (contact_id,inbound_message_id,status,reason,promotion_images_sent,
    result_images_selected,result_images_sent)
 SELECT contact_id,inbound_message_id,new_status,new_reason,promo_confirmed,
        result_total,result_confirmed
 FROM outcome
 ON CONFLICT(inbound_message_id) DO UPDATE SET
    status=EXCLUDED.status,reason=EXCLUDED.reason,
    promotion_images_sent=EXCLUDED.promotion_images_sent,
    result_images_selected=GREATEST(result_media_decisions.result_images_selected,
      EXCLUDED.result_images_selected),
    result_images_sent=EXCLUDED.result_images_sent,
    updated_at=NOW()
 WHERE result_media_decisions.contact_id=EXCLUDED.contact_id
 RETURNING inbound_message_id,status,reason
`;

// One bounded startup repair for records created before the live audit fix.
// Also repair expired images whose original pricing/result selector overwrote
// the queued-image audit with a generic skip reason.
// It only revisits terminal jobs with a stale "awaiting" / unconfirmed audit;
// it does not claim pending jobs, change delivery state or invoke Meta.
const RECENT_TERMINAL_SQL=`
 SELECT j.inbound_message_id
 FROM whatsapp_sender_ai_media_jobs j
 JOIN whatsapp_sender_accounts sa ON sa.id=j.sender_id
 JOIN result_media_decisions d ON d.inbound_message_id=j.inbound_message_id
   AND d.contact_id=j.contact_id
 WHERE sa.state='active' AND sa.sender_key=$1
   AND sa.meta_phone_number_id=$2 AND sa.meta_account_id=$3
   AND j.created_at>NOW()-INTERVAL '14 days'
   AND j.state IN('expired','accepted','unknown')
   AND (d.reason IN ('awaiting_sender_billing_receipt',
     'result_media_delivery_unconfirmed','secondary_media_waiting_delivery_receipt')
     OR (j.state='expired' AND d.status='skipped'
       AND d.reason NOT LIKE 'secondary_media_%'))
 GROUP BY j.inbound_message_id
 ORDER BY MAX(j.updated_at) DESC
 LIMIT 50
`;

async function reconcileSecondaryMediaAudit({
 inboundMessageIds,database=pool,env=process.env,
}={}){
 const ids=[...new Set((Array.isArray(inboundMessageIds)?inboundMessageIds:[])
   .map(Number).filter(v=>Number.isSafeInteger(v)&&v>0))];
 // Require exact secondary identity plus the already-approved automation mode.
 if(!ids.length || !secondaryAutomationActivation(env) ||
    env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED!=="true" ||
    env.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary" ||
    !/^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"")) ||
    !/^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_WABA_ID||"")))return 0;
 let updated=0;
 for(let i=0;i<ids.length;i+=100){
   const saved=await database.query(RECONCILE_SQL,[
     ids.slice(i,i+100),env.WHATSAPP_SECONDARY_SENDER_KEY,
     env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID
   ]);
   updated+=saved.rowCount||0;
 }
 return updated;
}
async function reconcileRecentTerminalMediaAudit({
 database=pool,env=process.env,
}={}){
 if(!secondaryAutomationActivation(env) ||
    env.WHATSAPP_SECONDARY_AI_MEDIA_ENABLED!=="true" ||
    env.WHATSAPP_SECONDARY_SENDER_KEY!=="neutro_secondary")return 0;
 const result=await database.query(RECENT_TERMINAL_SQL,[
   env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID,
 ]);
 return reconcileSecondaryMediaAudit({
   inboundMessageIds:(result.rows||[]).map(row=>row.inbound_message_id),
   database,env,
 });
}
module.exports={RECONCILE_SQL,RECENT_TERMINAL_SQL,
  reconcileSecondaryMediaAudit,reconcileRecentTerminalMediaAudit};
