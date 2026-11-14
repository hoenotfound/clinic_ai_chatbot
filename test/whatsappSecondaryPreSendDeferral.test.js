"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {
 isProvenPreProviderBlock,deferProvenUnsent,reclaimClause,
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
  assert.match(sql,/a.defer_count<8/);
  assert.match(sql,/SET delivery_status='cancelled'/);
  assert.match(sql,/status='deferred',message_id=NULL/);
  assert.deepEqual(args,[7,42,9001]);
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
