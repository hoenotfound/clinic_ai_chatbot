"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const review=require("../src/services/whatsappSecondaryUnknownHoldReviewService");

const reservationId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const env={
 WHATSAPP_SECONDARY_MANUAL_UNKNOWN_HOLD_RELEASE_ENABLED:"true",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
 WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
};
const approved={
 reservationId,releaseBasis:"signed_failed",firstReviewer:"operator_one",
 secondReviewer:"operator_two",evidenceTicket:"CASE_20261113_VIDEO",
 billingHubNoChargeChecked:true,businessAppReviewed:true,
 oldMessageRetryProhibited:true,
};
function mock({wamid="wamid.synthetic",receiptCount=1,failures=1,
  successCount=0,chargedCount=0,alarm=false,hasHold=true,gateUpdated=true}={}){
 const calls=[];
 let released=false;
 const database={
  connect:async()=>({
   query:async(sql,args=[])=>{
    calls.push({sql,args});
    if(sql.startsWith("SELECT id FROM whatsapp_sender_accounts"))
      return {rows:[{id:2}],rowCount:1};
    if(sql.startsWith("SELECT sender_id FROM whatsapp_sender_billing_gates"))
      return {rows:[{sender_id:2}],rowCount:1};
    if(sql===review.EXACT_UNKNOWN_HOLD_SQL)
      return {rows:hasHold?[{reservation_id:reservationId,sender_id:2,
        contact_id:9001,message_id:19111,wamid}]:[],rowCount:hasHold?1:0};
    if(sql.startsWith("SELECT 1 FROM whatsapp_sender_billing_alarms"))
      return {rows:alarm?[{ok:1}]:[]};
    if(sql===review.EXACT_RECEIPT_EVIDENCE_SQL)
      return {rows:[{receipt_count:receiptCount,verified_failure_count:failures,
        success_count:successCount,charged_count:chargedCount}]};
    if(sql.startsWith("UPDATE whatsapp_sender_billing_gates")){
      released=true;
      return {rowCount:gateUpdated?1:0};
    }
    return {rows:[],rowCount:1};
   },
   release:()=>{},
  }),
 };
 return {database,calls,get released(){return released}};
}
test("manual unknown hold releases default OFF and never authorize sends",async()=>{
 assert.equal(review.enabled({}),false);
 const f=mock();
 const result=await review.releaseReviewedSecondaryUnknownHold(approved,{
  database:f.database,env:{...env,WHATSAPP_SECONDARY_MANUAL_UNKNOWN_HOLD_RELEASE_ENABLED:"false"}});
 assert.equal(result.gateReleased,false);
 assert.equal(result.sendAuthorized,false);
 assert.equal(result.oldMessageRetryAllowed,false);
 assert.equal(f.calls.length,0);
});
test("requires two distinct reviewers and human external no-charge checks",async()=>{
 for(const patch of [
  {secondReviewer:"OPERATOR_ONE"},{billingHubNoChargeChecked:false},
  {businessAppReviewed:false},{oldMessageRetryProhibited:false},
  {evidenceTicket:"../phone.number"},{releaseBasis:"invented"},
 ]){
  const f=mock();
  const result=await review.releaseReviewedSecondaryUnknownHold({...approved,...patch},
   {database:f.database,env});
  assert.equal(result.gateReleased,false);
  assert.equal(f.calls.length,0);
 }
});
test("a signed failed receipt can release only the exact gate after independent review",async()=>{
 const f=mock();
 const result=await review.releaseReviewedSecondaryUnknownHold(approved,{
  database:f.database,env});
 assert.equal(result.gateReleased,true);
 assert.equal(result.sendAuthorized,false);
 assert.equal(result.oldMessageRetryAllowed,false);
 assert.equal(result.originalAttemptStillUnknown,true);
 assert.equal(f.released,true);
 assert.ok(f.calls.find(x=>x.sql.includes("INSERT INTO whatsapp_sender_unknown_hold_releases")));
 assert.ok(f.calls.find(x=>x.sql.includes("UPDATE whatsapp_sender_billing_gates")));
 assert.ok(f.calls.find(x=>x.sql==="COMMIT"));
 assert.equal(f.calls.some(x=>x.sql.includes("UPDATE whatsapp_sender_billing_attempts")),false,
  "preserve original UNKNOWN attempt for a future late receipt");
 assert.ok(f.calls.find(x=>x.sql.includes("UPDATE whatsapp_sender_followup_attempts")));
 assert.ok(f.calls.find(x=>x.sql.includes("UPDATE whatsapp_sender_marketing_followup_attempts")));
 assert.ok(f.calls.find(x=>x.sql.includes("secondary_reviewed_unknown_billing_hold")));
 assert.equal(f.calls.some(x=>x.sql.includes("messages SET")),false);
});
test("an unconfirmed send with no WAMID requires separate human review",async()=>{
 const f=mock({wamid:null,receiptCount:0,failures:0});
 const result=await review.releaseReviewedSecondaryUnknownHold({
  ...approved,releaseBasis:"unconfirmed_no_wamid"},{database:f.database,env});
 assert.equal(result.gateReleased,true);
 const wrongly=mock({wamid:"wamid.signed"});
 const rejected=await review.releaseReviewedSecondaryUnknownHold({
  ...approved,releaseBasis:"unconfirmed_no_wamid"},{database:wrongly.database,env});
 assert.equal(rejected.gateReleased,false);
 assert.equal(wrongly.released,false);
});
test("rejects contradictory receipts, sender alarms, no signed proof or changed reservation",async()=>{
 const cases=[
  mock({successCount:1}),mock({chargedCount:1}),mock({failures:0}),
  mock({alarm:true}),mock({hasHold:false}),mock({gateUpdated:false}),
 ];
 for(const f of cases){
  const result=await review.releaseReviewedSecondaryUnknownHold(approved,{
   database:f.database,env});
  assert.equal(result.gateReleased,false);
  assert.ok(f.calls.find(x=>x.sql==="ROLLBACK"));
  assert.ok(!f.calls.find(x=>x.sql==="COMMIT"));
 }
});
test("all exact-ownership checks remain sender-bound and the release cannot replay",()=>{
 for(const fragment of ["sc.customer_wa_id=c.whatsapp_number",
    "m.role='assistant'","mc.conversation_id=sc.id",
    "a.state='unknown'","g.state='unknown'",
    "sa.meta_phone_number_id=$3","sa.meta_account_id=$4"]){
  assert.ok(review.EXACT_UNKNOWN_HOLD_SQL.includes(fragment));
 }
 assert.ok(review.EXACT_RECEIPT_EVIDENCE_SQL.includes("r.delivery_status='failed'"));
 assert.ok(review.EXACT_UNKNOWN_HOLD_SQL.includes("a.wamid IS NULL AND m.whatsapp_message_id IS NULL"));
 assert.ok(review.EXACT_RECEIPT_EVIDENCE_SQL.includes("r.pricing_billable=TRUE"));
});
