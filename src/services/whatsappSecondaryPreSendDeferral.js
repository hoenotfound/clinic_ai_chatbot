"use strict";
// A temporary secondary billing lock is not a Meta delivery attempt.
// Only this precise pre-reservation refusal can safely defer an unsent slot.
const TABLES=new Set([
 "whatsapp_sender_followup_attempts",
 "whatsapp_sender_marketing_followup_attempts",
]);
const PRE_PROVIDER_CODE="secondary_billing_previous_send_unresolved";
function isProvenPreProviderBlock(result){
 return result?.code===PRE_PROVIDER_CODE &&
   result?.policyBlocked===true &&
   result?.success===false &&
   result?.unknown!==true &&
   result?.ambiguous!==true &&
   !result?.wamid;
}
// The unknown-gate refusal is also conclusively pre-reservation for THIS
// draft. Keep the stricter AI text retry predicate unchanged.
function isDeferrableFollowUpBlock(result){
 return isProvenPreProviderBlock(result) ||
   (result?.code==="secondary_billing_unknown_hold_not_reviewed" &&
    isProvenPreProviderBlock({...result,code:PRE_PROVIDER_CODE}));
}
// This single SQL statement atomically marks an unsent Inbox draft cancelled
// and retains the unique attempt row as deferred. No delete or blind replay.
// Reject if any provider/billing evidence exists, including a saved WAMID.
async function deferProvenUnsent({
 database,table,attemptId,messageId,contactId,result,
}){
 if(!TABLES.has(table) || !isDeferrableFollowUpBlock(result) ||
    !Number.isSafeInteger(Number(attemptId)) ||
    !Number.isSafeInteger(Number(messageId)) ||
    !Number.isSafeInteger(Number(contactId)))return false;
 const sql=`
  WITH eligible AS MATERIALIZED (
   SELECT a.id FROM ${table} a
   JOIN messages m ON m.id=a.message_id
   WHERE a.id=$1 AND a.message_id=$2 AND a.contact_id=$3
     AND a.status='claimed'
     AND m.contact_id=$3 AND m.role='assistant'
     AND m.delivery_status='unknown'
     AND m.whatsapp_message_id IS NULL
     AND m.whatsapp_accepted_at IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM whatsapp_sender_billing_attempts billing
       WHERE billing.message_id=m.id)
     AND NOT EXISTS (
       SELECT 1 FROM outbound_message_evidence evidence
       WHERE evidence.message_id=m.id)
   FOR UPDATE OF a,m
  ), cancelled AS (
   UPDATE messages m
   SET delivery_status='cancelled',
     delivery_error='Secondary follow-up deferred before provider send; no billing reservation.'
   WHERE m.id=$2 AND EXISTS(SELECT 1 FROM eligible)
   RETURNING m.id
  ), deferred AS (
   UPDATE ${table} a
   SET status='deferred',message_id=NULL,wamid=NULL,
       error_code='pre_provider_billing_deferred',
       retry_after=NOW()+
          LEAST(900,30*POWER(2,LEAST(a.defer_count,5)))*INTERVAL '1 second',
       defer_count=LEAST(8,a.defer_count+1),completed_at=NULL
   WHERE a.id=$1 AND a.status='claimed'
     AND EXISTS(SELECT 1 FROM cancelled)
   RETURNING a.id
  )
  SELECT id FROM deferred`;
 const rows=await database.query(sql,[Number(attemptId),Number(messageId),Number(contactId)]);
 return rows.rows?.length===1;
}
// The caller must retain the current contact, slot, consent and 24h
// checks. Only a verified deferred row may be reclaimed atomically.
const RECLAIM_SQL=` ON CONFLICT (sender_id,contact_id,anchor_message_id,slot_hours)
 DO UPDATE SET status='claimed',message_id=NULL,wamid=NULL,
    error_code=NULL,completed_at=NULL,retry_after=NULL,claimed_at=NOW()
 WHERE ${'TABLE'}.status='deferred'
   AND ${'TABLE'}.retry_after<=NOW()
   AND ${'TABLE'}.defer_count<=8
 RETURNING id`;
function reclaimClause(table){
 if(!TABLES.has(table))throw Error("Invalid secondary follow-up ledger");
 return RECLAIM_SQL.replaceAll("TABLE",table);
}
// Candidate scans skip slots before their durable deadline. The read-only
// scheduling hint looks ahead to that same deadline, without changing expiry.
const DEFERRED_READY_PREDICATE="attempted.status<>'deferred' OR attempted.retry_after IS NULL OR attempted.retry_after>$4::timestamptz";
function deferredRetryAtSql(table,anchor){
 if(!TABLES.has(table) || !["inbound.id","qualified_session.origin_id"].includes(anchor))
   throw Error("Invalid secondary follow-up deadline scope");
 return `(SELECT pending.retry_after FROM ${table} pending
   WHERE pending.sender_id=sa.id AND pending.contact_id=c.id
     AND pending.anchor_message_id=${anchor} AND pending.slot_hours=rule.slot_hours
     AND pending.status='deferred')`;
}
module.exports={isProvenPreProviderBlock,isDeferrableFollowUpBlock,deferProvenUnsent,reclaimClause,PRE_PROVIDER_CODE,DEFERRED_READY_PREDICATE,deferredRetryAtSql};
