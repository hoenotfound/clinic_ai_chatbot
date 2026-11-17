"use strict";

// Zero-operator recovery ONLY when the exact secondary Meta-signed failed
// message has explicit non-billable pricing. No historical replays or sends.
// Unknown/unpriced/no-WAMID receipts remain held for investigation.
const {pool}=require("../db/db");
const manual=require("./whatsappSecondaryUnknownHoldReviewService");
const realtimeEvents=require("../utils/realtimeEvents");

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function denied(code){return {gateReleased:false,sendAuthorized:false,oldMessageRetryAllowed:false,code};}
function enabled(env){
 return env.WHATSAPP_SECONDARY_SENDER_KEY==="neutro_secondary" &&
   /^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID||"")) &&
   /^[0-9]+$/.test(String(env.WHATSAPP_SECONDARY_WABA_ID||"")) &&
   env.WHATSAPP_SECONDARY_VERIFIED_FAILED_AUTO_RELEASE_ENABLED==="true";
}
const CANDIDATES_SQL=`
 SELECT a.reservation_id
 FROM whatsapp_sender_billing_attempts a
 JOIN whatsapp_sender_billing_gates g ON g.sender_id=a.sender_id
   AND g.owner_contact_id=a.contact_id
   AND g.contact_id=a.contact_id
   AND g.reservation_id=a.reservation_id
   AND g.message_id=a.message_id
 JOIN whatsapp_sender_accounts s ON s.id=a.sender_id
 JOIN messages m ON m.id=a.message_id AND m.contact_id=a.contact_id
 WHERE s.sender_key=$1 AND s.meta_phone_number_id=$2
   AND s.meta_account_id=$3 AND s.state='active'
   AND a.state='unknown' AND g.state='unknown'
   AND g.updated_at<NOW()-INTERVAL '30 minutes'
   AND m.delivery_status='failed' AND a.wamid LIKE 'wamid.%'
   AND EXISTS (SELECT 1 FROM whatsapp_sender_status_receipts receipt
     WHERE receipt.reservation_id=a.reservation_id
       AND receipt.sender_id=a.sender_id AND receipt.matched=TRUE
       AND receipt.wamid=a.wamid
       AND receipt.meta_phone_number_id=$2 AND receipt.meta_account_id=$3
       AND receipt.delivery_status='failed' AND receipt.pricing_billable=FALSE)
 ORDER BY g.updated_at ASC LIMIT 10
`;
const PROOF_SQL=`
 SELECT COUNT(*)::int AS receipt_count,
   COUNT(*) FILTER (WHERE r.matched=TRUE AND r.wamid=$3
     AND r.meta_phone_number_id=$4 AND r.meta_account_id=$5
     AND r.delivery_status='failed' AND r.pricing_billable=FALSE)::int
     AS verified_nonbillable_failure_count,
   COUNT(*) FILTER (WHERE r.delivery_status IN ('delivered','read'))::int
     AS success_count,
   COUNT(*) FILTER (WHERE r.pricing_billable IS DISTINCT FROM FALSE)::int
     AS uncertain_billing_count,
   COUNT(*) FILTER (WHERE r.matched IS DISTINCT FROM TRUE
     OR r.wamid IS DISTINCT FROM $3
     OR r.meta_phone_number_id IS DISTINCT FROM $4
     OR r.meta_account_id IS DISTINCT FROM $5)::int AS mismatched_count,
   MIN(r.fingerprint) FILTER (WHERE r.matched=TRUE
     AND r.delivery_status='failed' AND r.pricing_billable=FALSE
     AND r.wamid=$3 AND r.meta_phone_number_id=$4 AND r.meta_account_id=$5)
     AS proof_fingerprint
 FROM whatsapp_sender_status_receipts r
 WHERE r.reservation_id=$1::uuid AND r.sender_id=$2
`;
async function releaseVerifiedNonbillableFailure({reservationId},
 {database=pool,env=process.env}={}){
 if(!enabled(env))return denied("secondary_auto_release_disabled");
 if(!UUID.test(String(reservationId||"")) ||
    typeof database?.connect!=="function")
   return denied("secondary_auto_release_invalid_input");
 let client,tx=false;
 try{
  client=await database.connect();
  await client.query("BEGIN");tx=true;
  // Match the provider receipt writer's lock ordering.
  const sender=await client.query(
   "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 "+
   "AND meta_phone_number_id=$2 AND meta_account_id=$3 AND state='active' FOR UPDATE",
   [env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    env.WHATSAPP_SECONDARY_WABA_ID]);
  if(sender.rows?.length!==1){await client.query("ROLLBACK");tx=false;
   return denied("secondary_auto_release_wrong_sender");}
  const senderId=sender.rows[0].id;
  await client.query(
   "SELECT sender_id FROM whatsapp_sender_billing_gates WHERE sender_id=$1 FOR UPDATE",
   [senderId]);
  const owned=await client.query(manual.EXACT_UNKNOWN_HOLD_SQL,[
   reservationId,env.WHATSAPP_SECONDARY_SENDER_KEY,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]);
  if(owned.rows?.length!==1 ||
     String(owned.rows[0].sender_id)!==String(senderId)){
   await client.query("ROLLBACK");tx=false;
   return denied("secondary_auto_release_no_matching_hold");
  }
  const attempt=owned.rows[0];
  if(!/^wamid\./.test(String(attempt.wamid||""))){
   await client.query("ROLLBACK");tx=false;
   return denied("secondary_auto_release_no_provider_wamid");
  }
  const overdue=await client.query(
   "SELECT 1 FROM whatsapp_sender_billing_gates WHERE sender_id=$1 "+
   "AND owner_contact_id=$2 AND reservation_id=$3::uuid "+
   "AND updated_at<NOW()-INTERVAL '30 minutes'",
   [senderId,attempt.contact_id,reservationId]);
  if(overdue.rowCount!==1){await client.query("ROLLBACK");tx=false;
   return denied("secondary_auto_release_wait_for_late_receipts");}
  const msg=await client.query(
   "SELECT 1 FROM messages WHERE id=$1 AND contact_id=$2 "+
   "AND delivery_status='failed' AND whatsapp_message_id=$3",
   [attempt.message_id,attempt.contact_id,attempt.wamid]);
  if(msg.rowCount!==1){await client.query("ROLLBACK");tx=false;
   return denied("secondary_auto_release_message_not_failed");}
  const alarm=await client.query(
   "SELECT 1 FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",[senderId]);
  if(alarm.rows?.length){await client.query("ROLLBACK");tx=false;
   return denied("secondary_auto_release_sender_alarm");}
  const evidence=await client.query(PROOF_SQL,[
   reservationId,senderId,attempt.wamid,
   env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]);
  const p=evidence.rows?.[0];
  if(!p || Number(p.receipt_count)<1 ||
     Number(p.verified_nonbillable_failure_count)<1 ||
     Number(p.success_count)!==0 ||
     Number(p.uncertain_billing_count)!==0 ||
     Number(p.mismatched_count)!==0 ||
     !/^[a-f0-9]{64}$/.test(String(p.proof_fingerprint||""))){
   await client.query("ROLLBACK");tx=false;
   return denied("secondary_auto_release_no_explicit_nonbillable_proof");
  }
  const audit=await client.query(
   `INSERT INTO whatsapp_sender_automatic_unknown_hold_releases
      (reservation_id,sender_id,contact_id,message_id,proof_receipt_fingerprint)
    VALUES ($1::uuid,$2,$3,$4,$5)
    ON CONFLICT(reservation_id) DO NOTHING RETURNING reservation_id`,
   [reservationId,senderId,attempt.contact_id,attempt.message_id,p.proof_fingerprint]);
  if(audit.rowCount!==1){await client.query("ROLLBACK");tx=false;
   return denied("secondary_auto_release_already_processed");}
  const changed=await client.query(
   `UPDATE whatsapp_sender_billing_gates SET
      state='idle',reservation_id=NULL,contact_id=NULL,message_id=NULL,
      wamid=NULL,updated_at=NOW()
    WHERE sender_id=$1 AND owner_contact_id=$2 AND
      reservation_id=$3::uuid AND contact_id=$2 AND
      message_id=$4 AND state='unknown'`,
   [senderId,attempt.contact_id,reservationId,attempt.message_id]);
  if(changed.rowCount!==1)throw Error("Exact unknown billing gate changed");
  for(const ledger of ["whatsapp_sender_followup_attempts",
                       "whatsapp_sender_marketing_followup_attempts"]){
   await client.query(
    "UPDATE "+ledger+" SET status='unknown', "+
    "error_code='secondary_auto_verified_nonbillable_failure' "+
    "WHERE sender_id=$1 AND contact_id=$2 AND message_id=$3 "+
    "AND status IN ('claimed','accepted')",
    [senderId,attempt.contact_id,attempt.message_id]);
  }
  const attention=await client.query(
   `UPDATE contacts c SET
     needs_attention=EXISTS(
       SELECT 1 FROM ai_review_items r WHERE r.contact_id=c.id
         AND r.status='pending'),
     attention_reason=CASE WHEN EXISTS(
       SELECT 1 FROM ai_review_items r WHERE r.contact_id=c.id
         AND r.status='pending')
       THEN 'AI review still pending' ELSE NULL END,
     delivery_attention_message_id=NULL,updated_at=NOW()
    WHERE c.id=$1 AND c.whatsapp_sender_id=$2
      AND c.delivery_attention_message_id=$3 AND c.needs_attention=TRUE
      AND (c.attention_reason LIKE 'Delivery failed:%'
           OR c.attention_reason LIKE 'Delivery unconfirmed:%')
      AND NOT EXISTS (SELECT 1 FROM whatsapp_sender_billing_gates other
         WHERE other.sender_id=$2 AND other.owner_contact_id=c.id
           AND other.state<>'idle')`,
   [attempt.contact_id,senderId,attempt.message_id]);
  await client.query("COMMIT");tx=false;
  if(database===pool)try{
   realtimeEvents.publish("conversation_changed",{
     contactId:attempt.contact_id,reason:"delivery_status",
     messageId:attempt.message_id});
  }catch{}
  return {gateReleased:true,sendAuthorized:false,oldMessageRetryAllowed:false,
    originalAttemptStillUnknown:true,
    deliveryAttentionResolved:attention.rowCount===1};
 }catch{
  if(tx&&client)await client.query("ROLLBACK").catch(()=>{});
  return denied("secondary_auto_release_database_or_audit_failed");
 }finally{if(client)client.release();}
}
async function sweepVerifiedNonbillableFailures({database=pool,env=process.env}={}){
 if(!enabled(env))return {examined:0,released:0};
 const found=await database.query(CANDIDATES_SQL,[
   env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
   env.WHATSAPP_SECONDARY_WABA_ID]);
 let released=0;
 for(const row of found.rows||[]){
  const result=await releaseVerifiedNonbillableFailure({
   reservationId:row.reservation_id},{database,env});
  if(result.gateReleased)released++;
 }
 return {examined:(found.rows||[]).length,released};
}
module.exports={enabled,CANDIDATES_SQL,PROOF_SQL,
 releaseVerifiedNonbillableFailure,sweepVerifiedNonbillableFailures};
