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
// This single SQL statement atomically marks an unsent Inbox draft cancelled
// and retains the unique attempt row as deferred. No delete or blind replay.
// Reject if any provider/billing evidence exists, including a saved WAMID.
async function deferProvenUnsent({
 database,table,attemptId,messageId,contactId,result,
}){
 if(!TABLES.has(table) || !isProvenPreProviderBlock(result) ||
    !Number.isSafeInteger(Number(attemptId)) ||
    !Number.isSafeInteger(Number(messageId)) ||
    !Number.isSafeInteger(Number(contactId)))return false;
 const sql=`
  WITH eligible AS MATERIALIZED (
   SELECT a.id FROM ${table} a
   JOIN messages m ON m.id=a.message_id
   WHERE a.id=$1 AND a.message_id=$2 AND a.contact_id=$3
     AND a.status='claimed' AND a.defer_count<8
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
          LEAST(180,30*POWER(2,a.defer_count))*INTERVAL '1 second',
       defer_count=a.defer_count+1,completed_at=NULL
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
module.exports={isProvenPreProviderBlock,deferProvenUnsent,reclaimClause,PRE_PROVIDER_CODE};
