"use strict";

// Offline, two-reviewer operator-only hold release. No API route, scheduler,
// webhook or sender imports this module. It NEVER sends or retries a message.
// A release is not evidence that Meta delivered or that the message was free.
const {pool}=require("../db/db");

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TICKET=/^[A-Z0-9_-]{8,80}$/;
function denied(code){return {gateReleased:false,sendAuthorized:false,oldMessageRetryAllowed:false,code};}
function clean(v){return typeof v==="string"?v.trim():"";}
function enabled(env){
  return env.WHATSAPP_SECONDARY_MANUAL_UNKNOWN_HOLD_RELEASE_ENABLED==="true" &&
    env.WHATSAPP_SECONDARY_SENDER_KEY==="neutro_secondary" &&
    /^[0-9]+$/.test(clean(env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID)) &&
    /^[0-9]+$/.test(clean(env.WHATSAPP_SECONDARY_WABA_ID));
}

const EXACT_UNKNOWN_HOLD_SQL=`
 SELECT a.reservation_id,a.sender_id,a.contact_id,a.message_id,a.wamid
 FROM whatsapp_sender_billing_attempts a
 JOIN whatsapp_sender_accounts sa ON sa.id=a.sender_id
 JOIN contacts c ON c.id=a.contact_id AND c.whatsapp_sender_id=sa.id
 JOIN whatsapp_sender_conversations sc ON sc.contact_id=c.id
   AND sc.sender_id=sa.id AND sc.state='bound'
   AND sc.customer_wa_id=c.whatsapp_number
 JOIN messages m ON m.id=a.message_id AND m.contact_id=c.id
   AND m.role='assistant'
 JOIN whatsapp_sender_message_context mc ON mc.message_id=m.id
   AND mc.conversation_id=sc.id
 JOIN whatsapp_sender_billing_gates g ON g.sender_id=a.sender_id
   AND g.owner_contact_id=c.id AND g.contact_id=c.id
   AND g.message_id=a.message_id AND g.reservation_id=a.reservation_id
 WHERE a.reservation_id=$1::uuid AND a.state='unknown' AND g.state='unknown'
   AND sa.sender_key=$2 AND sa.meta_phone_number_id=$3
   AND sa.meta_account_id=$4 AND sa.state='active'
   AND (a.wamid IS NULL OR m.whatsapp_message_id=a.wamid)
 FOR UPDATE OF a,g
`;

const EXACT_RECEIPT_EVIDENCE_SQL=`
 SELECT
   COUNT(*)::int AS receipt_count,
   COUNT(*) FILTER (WHERE r.matched=TRUE AND r.delivery_status='failed'
     AND r.wamid=$3 AND r.meta_phone_number_id=$4
     AND r.meta_account_id=$5)::int AS verified_failure_count,
   COUNT(*) FILTER (WHERE r.delivery_status IN('delivered','read'))::int
      AS success_count,
   COUNT(*) FILTER (WHERE r.pricing_billable=TRUE)::int AS charged_count
 FROM whatsapp_sender_status_receipts r
 WHERE r.reservation_id=$1::uuid AND r.sender_id=$2
`;

async function releaseReviewedSecondaryUnknownHold({
  reservationId,releaseBasis,firstReviewer,secondReviewer,evidenceTicket,
  billingHubNoChargeChecked=false,businessAppReviewed=false,
  oldMessageRetryProhibited=false,
}, {database=pool,env=process.env}={}){
  if(!enabled(env))return denied("secondary_unknown_review_disabled");
  const reservation=clean(reservationId);
  const first=clean(firstReviewer),second=clean(secondReviewer),ticket=clean(evidenceTicket);
  if(!UUID.test(reservation) ||
     !["signed_failed","unconfirmed_no_wamid"].includes(releaseBasis) ||
     !/^[A-Za-z0-9._-]{3,80}$/.test(first) ||
     !/^[A-Za-z0-9._-]{3,80}$/.test(second) ||
     first.toLowerCase()===second.toLowerCase() || !TICKET.test(ticket) ||
     billingHubNoChargeChecked!==true || businessAppReviewed!==true ||
     oldMessageRetryProhibited!==true ||
     typeof database?.connect!=="function")
     return denied("secondary_unknown_review_two_independent_checks_required");
  let client,tx=false;
  try{
    client=await database.connect();
    await client.query("BEGIN");tx=true;
    // Same lock order as signed Meta receipt ingestion and new reservations.
    const sender=await client.query(
      "SELECT id FROM whatsapp_sender_accounts WHERE sender_key=$1 "+
      "AND meta_phone_number_id=$2 AND meta_account_id=$3 AND state='active' FOR UPDATE",
      [env.WHATSAPP_SECONDARY_SENDER_KEY,env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
       env.WHATSAPP_SECONDARY_WABA_ID]);
    if(sender.rows?.length!==1){await client.query("ROLLBACK");tx=false;
      return denied("secondary_unknown_review_sender_unverified");}
    const senderId=sender.rows[0].id;
    await client.query(
      "SELECT sender_id FROM whatsapp_sender_billing_gates WHERE sender_id=$1 FOR UPDATE",
      [senderId]);
    const owner=await client.query(EXACT_UNKNOWN_HOLD_SQL,[
      reservation,env.WHATSAPP_SECONDARY_SENDER_KEY,
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]);
    if(owner.rows?.length!==1 || String(owner.rows[0].sender_id)!==String(senderId)){
      await client.query("ROLLBACK");tx=false;
      return denied("secondary_unknown_review_no_matching_live_hold");
    }
    const attempt=owner.rows[0];
    // Unexpected provider billing is a number-wide incident and never
    // cleared through a customer-specific review.
    const alarm=await client.query(
      "SELECT 1 FROM whatsapp_sender_billing_alarms WHERE sender_id=$1",
      [senderId]);
    if(alarm.rows?.length){await client.query("ROLLBACK");tx=false;
      return denied("secondary_unknown_review_sender_alarm");}
    const evidence=await client.query(EXACT_RECEIPT_EVIDENCE_SQL,[
      reservation,senderId,attempt.wamid,
      env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,env.WHATSAPP_SECONDARY_WABA_ID]);
    const proof=evidence.rows?.[0];
    if(!proof || Number(proof.charged_count)!==0 ||
       Number(proof.success_count)!==0){
      await client.query("ROLLBACK");tx=false;
      return denied("secondary_unknown_review_conflicting_provider_receipt");
    }
    if(releaseBasis==="signed_failed" &&
       (!/^wamid\\./.test(clean(attempt.wamid)) ||
        Number(proof.verified_failure_count)<1)){
      await client.query("ROLLBACK");tx=false;
      return denied("secondary_unknown_review_signed_failure_missing");
    }
    if(releaseBasis==="unconfirmed_no_wamid" &&
       (attempt.wamid!==null || Number(proof.receipt_count)!==0)){
      await client.query("ROLLBACK");tx=false;
      return denied("secondary_unknown_review_unconfirmed_not_proven");
    }
    // Written audit must commit atomically with ONLY this contact's gate.
    await client.query(
      `INSERT INTO whatsapp_sender_unknown_hold_releases
        (reservation_id,sender_id,contact_id,message_id,release_basis,
         billing_hub_no_charge_checked,business_app_reviewed,
         old_message_retry_prohibited,first_reviewer,second_reviewer,evidence_ticket)
       VALUES($1,$2,$3,$4,$5,TRUE,TRUE,TRUE,$6,$7,$8)`,
      [reservation,senderId,attempt.contact_id,attempt.message_id,
       releaseBasis,first,second,ticket]);
    const changed=await client.query(
      `UPDATE whatsapp_sender_billing_gates
       SET state='idle',reservation_id=NULL,contact_id=NULL,message_id=NULL,
           wamid=NULL,updated_at=NOW()
       WHERE sender_id=$1 AND owner_contact_id=$2 AND reservation_id=$3::uuid
         AND contact_id=$2 AND message_id=$4 AND state='unknown'`,
      [senderId,attempt.contact_id,reservation,attempt.message_id]);
    if(changed.rowCount!==1)throw Error("Lost exact unknown hold under review");
    // The original billing attempt intentionally stays UNKNOWN. Late
    // signed provider receipts can still be matched and investigated.
    await client.query("COMMIT");tx=false;
    return {gateReleased:true,sendAuthorized:false,oldMessageRetryAllowed:false,
      originalAttemptStillUnknown:true};
  }catch{
    if(tx&&client)await client.query("ROLLBACK").catch(()=>{});
    return denied("secondary_unknown_review_database_or_audit_failed");
  }finally{
    if(client)client.release();
  }
}
module.exports={enabled,EXACT_UNKNOWN_HOLD_SQL,EXACT_RECEIPT_EVIDENCE_SQL,
  releaseReviewedSecondaryUnknownHold};
