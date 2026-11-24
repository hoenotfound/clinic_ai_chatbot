"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {
 isProvenPreProviderBlock,isDeferrableFollowUpBlock,deferProvenUnsent,reclaimClause,
}=require("../src/services/whatsappSecondaryPreSendDeferral");
const gate={success:false,policyBlocked:true,retryable:false,
 code:"secondary_billing_previous_send_unresolved",wamid:null};
test("only exact pre-reservation temporary gate block is deferrable",()=>{
 assert.equal(isProvenPreProviderBlock(gate),true);
 for(const change of [
  {wamid:"wamid.proven"},
  {unknown:true},
  {ambiguous:true},
  {policyBlocked:false},
  {code:"secondary_staff_provider_outcome_unverified"},
  {code:"secondary_billing_sender_alarm"},
  {success:true},
 ])assert.equal(isProvenPreProviderBlock({...gate,...change}),false);
});
test("defer requires provider-proof exclusions and atomic cancelled Inbox draft",async()=>{
 let called=0;
 const db={query:async(sql,args)=>{
  called++;
  assert.match(sql,/FOR UPDATE OF a,m/);
  assert.match(sql,/whatsapp_sender_billing_attempts/);
  assert.match(sql,/outbound_message_evidence/);
  assert.match(sql,/m.whatsapp_message_id IS NULL/);
  assert.match(sql,/m.whatsapp_accepted_at IS NULL/);
  assert.match(sql,/defer_count=LEAST\(8,a.defer_count\+1\)/);
   assert.doesNotMatch(sql,/a.defer_count<8/);
   assert.match(sql,/LEAST\(900,30\*POWER/);
  assert.match(sql,/SET delivery_status='cancelled'/);
  assert.match(sql,/status='deferred',message_id=NULL/);
  assert.deepEqual(args,[7,42,9001,false]);
  return {rows:[{id:7}]};
 }};
 assert.equal(await deferProvenUnsent({
  database:db,table:"whatsapp_sender_followup_attempts",
  attemptId:7,messageId:42,contactId:9001,result:gate
 }),true);
 assert.equal(called,1);
 assert.equal(await deferProvenUnsent({
  database:db,table:"whatsapp_sender_followup_attempts",
  attemptId:7,messageId:42,contactId:9001,
  result:{...gate,unknown:true}
 }),false);
 assert.equal(called,1);
});
test("marketing and service share a bounded one-shot reclaim, no unsafe table",()=>{
 for(const table of ["whatsapp_sender_followup_attempts",
                       "whatsapp_sender_marketing_followup_attempts"]){
  const sql=reclaimClause(table);
  assert.match(sql,/ON CONFLICT \(sender_id,contact_id,anchor_message_id,slot_hours\)/);
  assert.match(sql,/retry_after<=NOW\(\)/);
  assert.match(sql,/status='deferred'/);
  assert.match(sql,/defer_count<=8/);
 }
 assert.throws(()=>reclaimClause("messages"));
});

test("unknown hold refusal defers only the new provably unsent follow-up",()=>{
 const blocked={...gate,code:"secondary_billing_unknown_hold_not_reviewed"};
 assert.equal(isProvenPreProviderBlock(blocked),false);
 assert.equal(isDeferrableFollowUpBlock(blocked),true);
 for(const change of [{unknown:true},{ambiguous:true},{wamid:"wamid.proven"},{policyBlocked:false},{success:true}])
   assert.equal(isDeferrableFollowUpBlock({...blocked,...change}),false);
});

test("only explicit pre-send proof can defer a durably rejected reservation",async()=>{
 const marker={success:false,preProviderCancelled:true,code:"secondary_pre_provider_preflight_exception"};
 const proof=[];
 const db={query:async(sql,args)=>{
  assert.match(sql,/billing.state<>'rejected'/);
  assert.match(sql,/whatsapp_sender_status_receipts/);
  assert.match(sql,/billing.wamid IS NOT NULL/);
  proof.push(args[3]);return {rows:[{id:7}]};
 }};
 const input={database:db,table:"whatsapp_sender_followup_attempts",attemptId:7,messageId:42,contactId:9001};
 assert.equal(await deferProvenUnsent({...input,result:marker}),true);
 assert.equal(await deferProvenUnsent({...input,result:{...marker,noReservation:true}}),true);
 assert.deepEqual(proof,[true,false]);
 for(const extra of [{unknown:true},{ambiguous:true},{wamid:"wamid.actual"},{success:true}])
   assert.equal(await deferProvenUnsent({...input,result:{...marker,...extra}}),false);
});
