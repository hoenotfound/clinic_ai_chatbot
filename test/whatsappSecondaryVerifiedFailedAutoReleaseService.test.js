"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const service=require("../src/services/whatsappSecondaryVerifiedFailedAutoReleaseService");
const manual=require("../src/services/whatsappSecondaryUnknownHoldReviewService");

const reservationId="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const env={
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
 WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
 WHATSAPP_SECONDARY_VERIFIED_FAILED_AUTO_RELEASE_ENABLED:"true",
};
function mock({wamid="wamid.synthetic",successCount=0,uncertainBillingCount=0,
 mismatchedCount=0,nonbillableFailureCount=1,alarm=false,hasHold=true,
 mature=true,failed=true,auditInserted=true,gateUpdated=true}={}){
 const calls=[];
 let released=false;
 const client={
  async query(sql,args=[]){
   calls.push({sql,args});
   if(sql.startsWith("SELECT id FROM whatsapp_sender_accounts"))
    return {rows:[{id:2}],rowCount:1};
   if(sql.startsWith("SELECT sender_id FROM whatsapp_sender_billing_gates"))
    return {rows:[],rowCount:0};
   if(sql===manual.EXACT_UNKNOWN_HOLD_SQL)
    return {rows:hasHold?[{sender_id:2,contact_id:9001,message_id:19111,wamid}]:[],
      rowCount:hasHold?1:0};
   if(sql.startsWith("SELECT 1 FROM whatsapp_sender_billing_gates"))
    return {rows:mature?[{ok:1}]:[],rowCount:mature?1:0};
   if(sql.startsWith("SELECT 1 FROM messages"))
    return {rows:failed?[{ok:1}]:[],rowCount:failed?1:0};
   if(sql.startsWith("SELECT 1 FROM whatsapp_sender_billing_alarms"))
    return {rows:alarm?[{ok:1}]:[],rowCount:alarm?1:0};
   if(sql===service.PROOF_SQL)return {rows:[{
    receipt_count:1,verified_nonbillable_failure_count:nonbillableFailureCount,
    success_count:successCount,uncertain_billing_count:uncertainBillingCount,
    mismatched_count:mismatchedCount,proof_fingerprint:"a".repeat(64)}],
    rowCount:1};
   if(sql.startsWith("INSERT INTO whatsapp_sender_automatic_unknown_hold_releases"))
    return {rows:auditInserted?[{reservation_id:reservationId}]:[],
      rowCount:auditInserted?1:0};
   if(sql.startsWith("UPDATE whatsapp_sender_billing_gates")){
    released=true;return {rows:[],rowCount:gateUpdated?1:0};
   }
   if(sql.startsWith("UPDATE contacts c"))return {rows:[],rowCount:1};
   return {rows:[],rowCount:1};
  },
  release(){},
 };
 const database={
  connect:async()=>client,
  query:async(sql,args=[])=>{
   calls.push({sql,args});
   if(sql===service.CANDIDATES_SQL)return {rows:[{reservation_id:reservationId}]};
   throw Error("Unexpected outside query");
  },
 };
 return {database,calls,get released(){return released;}};
}
test("auto recovery disabled by default; never requires an operator",async()=>{
 assert.equal(service.enabled({}),false);
 const fixture=mock();
 const result=await service.releaseVerifiedNonbillableFailure({reservationId},
  {database:fixture.database,env:{...env,WHATSAPP_SECONDARY_VERIFIED_FAILED_AUTO_RELEASE_ENABLED:"false"}});
 assert.equal(result.gateReleased,false);
 assert.equal(result.sendAuthorized,false);
 assert.equal(result.oldMessageRetryAllowed,false);
 assert.equal(fixture.calls.length,0);
});
test("only exact signed, explicitly nonbillable failed receipt can clear its gate",async()=>{
 const fixture=mock();
 const result=await service.releaseVerifiedNonbillableFailure({reservationId},
  {database:fixture.database,env});
 assert.equal(result.gateReleased,true);
 assert.equal(result.sendAuthorized,false);
 assert.equal(result.oldMessageRetryAllowed,false);
 assert.equal(result.originalAttemptStillUnknown,true);
 assert.equal(fixture.released,true);
 assert.ok(fixture.calls.some(x=>x.sql==="COMMIT"));
 const audit=fixture.calls.find(x=>x.sql.startsWith(
  "INSERT INTO whatsapp_sender_automatic_unknown_hold_releases"));
 assert.ok(audit);
 assert.deepEqual(audit.args,[reservationId,2,9001,19111,"a".repeat(64)]);
 assert.equal(fixture.calls.some(x=>x.sql.includes("UPDATE whatsapp_sender_billing_attempts")),false);
 assert.equal(fixture.calls.some(x=>x.sql.includes("UPDATE messages SET")),false);
 assert.equal(fixture.calls.some(x=>x.sql.includes("sendMessage")),false);
});
test("unknown pricing, delivered/read, wrong receipt, alarm or weak ownership never release",async()=>{
 for(const options of [
  {wamid:null},{nonbillableFailureCount:0},{uncertainBillingCount:1},
  {successCount:1},{mismatchedCount:1},{alarm:true},
  {hasHold:false},{mature:false},{failed:false},{auditInserted:false},
  {gateUpdated:false},
 ]){
  const fixture=mock(options);
  const result=await service.releaseVerifiedNonbillableFailure({reservationId},
   {database:fixture.database,env});
  assert.equal(result.gateReleased,false,JSON.stringify(options));
  assert.ok(!fixture.calls.some(x=>x.sql==="COMMIT"),JSON.stringify(options));
  if(fixture.released)assert.ok(fixture.calls.some(x=>x.sql==="ROLLBACK"));
 }
});
test("worker can reconcile eligible holds without anyone invoking a manual release",async()=>{
 const fixture=mock();
 const outcome=await service.sweepVerifiedNonbillableFailures({database:fixture.database,env});
 assert.deepEqual(outcome,{examined:1,released:1});
 assert.ok(fixture.calls.some(x=>x.sql===service.CANDIDATES_SQL));
 assert.match(service.CANDIDATES_SQL,/INTERVAL '30 minutes'/);
 assert.match(service.PROOF_SQL,/pricing_billable=FALSE/);
 assert.match(service.PROOF_SQL,/pricing_billable IS DISTINCT FROM FALSE/);
});
