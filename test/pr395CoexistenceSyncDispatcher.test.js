"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {assertSafeCommand,reserveOnce,dispatchOnce,quarantineStaleClaims}=
  require("../src/services/pr395CoexistenceSyncDispatcher");
const env={
 PR395_STAGING_MODE:"true",PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED:"true",
 PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"true",
 WHATSAPP_SECONDARY_WABA_ID:"200002",WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"300003",
 WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60189990000",
 PR395_STAGING_APPROVED_TEST_PHONE_E164:"+60189990000",
 WHATSAPP_WABA_ID:"100001",WHATSAPP_PHONE_NUMBER_ID:"400004",
 META_GRAPH_API_VERSION:"v26.0"
};
const input={
 onboardingAttemptId:7,wabaId:"200002",phoneNumberId:"300003",
 syncType:"history",onboardingCompletedAt:"2026-10-27T06:00:00Z",
 operatorApproved:true,receiverReady:true,importerReady:true,
 verifiedAppSubscription:true,verifiedCallbackOverride:true,
 syncConsent:true,historyConsent:true,
 consentSource:"embedded_signup_owner",consentVerifiedBy:"qa_owner"
};
const now=new Date("2026-10-27T07:00:00Z");
function db(){
 const requests=new Map(),queries=[];
 let next=1,failFinalize=false;
 return{requests,queries,set failFinalize(v){failFinalize=v},
 async query(sql,params=[]){
  queries.push({sql,params});
  if(sql.startsWith("SELECT id FROM whatsapp_sender_accounts")) {
   return {rows: [{id: 71}]};
  }
  if(sql.startsWith("INSERT INTO whatsapp_coexistence_sync_dispatch_requests")){
   let key=params[1]+":"+params[2]+":"+params[3];
   if(requests.has(key))return{rows:[]};
   const row={id:next++,state:"reserved",key};requests.set(key,row);
   return{rows:[row]};
  }
  if(sql.startsWith("UPDATE whatsapp_coexistence_sync_dispatch_requests")){
   if(sql.includes("SET state='dispatching'")){
    let row=[...requests.values()].find(r=>r.id===params[0]);
    if(!row||row.state!=="reserved")return{rows:[]};
    row.state="dispatching";return{rows:[{id:row.id}]};
   }
   if(sql.includes("SET state=$2")){
    if(failFinalize)throw Error("db unavailable");
    let row=[...requests.values()].find(r=>r.id===params[0]);
    row.state=params[1];return{rowCount:1};
   }
  }
  return{rows:[]};
 }};
}
const loadCredential=async()=>({accessToken:"SECRET",wabaId:input.wabaId,phoneNumberId:input.phoneNumberId});
function response(status, data){
 return{status,ok:status>=200&&status<300,async json(){return data}};
}
test("only explicit consent, isolated staging, exact sender, and unexpired signup can dispatch",()=>{
 assert.doesNotThrow(()=>assertSafeCommand(input,env,now));
 for(const bad of [
  [{historyConsent:false},env], [{syncConsent:false},env],
  [{operatorApproved:false},env],[{verifiedCallbackOverride:false},env],
  [{phoneNumberId:"400004"},env],[{syncType:"invalid"},env],
  [{onboardingCompletedAt:"2026-10-26T05:00:00Z"},env],
  [{}, {...env,PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED:"false"}],
  [{}, {...env,WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true"}],
  [{}, {...env,PR395_STAGING_MODE:"false"}],
  [{}, {...env,PR395_STAGING_APPROVED_TEST_PHONE_E164:"+60174831336"}]
 ])assert.throws(()=>assertSafeCommand({...input,...bad[0]},bad[1],now));
});
test("validated onboarding can reserve exactly once across duplicate callers",async()=>{
 const database=db();
 const options={database,env,now};
 await reserveOnce(input,options);
 await assert.rejects(()=>reserveOnce(input,options),/already reserved/);
 assert.equal(database.requests.size,1);
});
test("only one Meta POST even when the first request timed out",async()=>{
 const database=db();let sends=0;
 const options={database,env,now,loadCredential,
  fetchImpl:async(url,opts)=>{
   sends++;assert.match(url,/\/300003\/smb_app_data$/);
   assert.equal(opts.method,"POST");
   assert.equal(JSON.parse(opts.body).sync_type,"history");
   throw Error("network timeout");
  }};
 const first=await dispatchOnce(input,options);
 assert.equal(first.state,"unknown");
 await assert.rejects(()=>dispatchOnce(input,options),/already reserved/);
 assert.equal(sends,1);
 assert.equal([...database.requests.values()][0].state,"unknown");
});
test("confirmed success, explicit provider rejection and ambiguous 2xx are separate terminal states",async()=>{
 for(const [status,payload,expected] of [
  [200,{messaging_product:"whatsapp",request_id:"meta-req-123"},"accepted"],
  [200,{success:true},"accepted"],[403,{error:{code:5}},"rejected"],
  [200,{unexpected:"yes"},"unknown"],[429,{error:{code:4}},"unknown"]
 ]){
  const database=db();
  const result=await dispatchOnce(input,{database,env,now,loadCredential,
   fetchImpl:async()=>response(status,payload)});
  assert.equal(result.state,expected);
  assert.equal([...database.requests.values()][0].state,expected);
  if(payload.request_id)assert.equal(result.providerRequestId,payload.request_id);
 }
});
test("database failure AFTER POST leaves durable dispatching claim and blocks automatic retry",async()=>{
 const database=db();database.failFinalize=true;let calls=0;
 await assert.rejects(()=>dispatchOnce(input,{database,env,now,loadCredential,
  fetchImpl:async()=>{calls++;return response(200,{success:true})}
 }),/Treat as UNKNOWN/);
 assert.equal([...database.requests.values()][0].state,"dispatching");
 await assert.rejects(()=>dispatchOnce(input,{database,env,now,loadCredential,
  fetchImpl:async()=>{calls++;throw Error("should not call")}
 }),/already reserved/);
 assert.equal(calls,1);
});
test("failed prerequisite or inaccessible credentials never triggers Meta POST",async()=>{
 const database=db();let calls=0;
 await assert.rejects(()=>dispatchOnce(input,{database,env,now,
  loadCredential:async()=>{throw Error("vault unavailable")},
  fetchImpl:async()=>{calls++;return response(200,{success:true})}
 }),/vault unavailable/);
 assert.equal(calls,0);
 assert.equal(database.requests.size,0);
});
test("stale claim quarantine is review-only, never POST",async()=>{
 const database={async query(sql,params){
  assert.match(sql,/state='unknown'/);
  assert.deepEqual(params,[3]);return{rows:[{id:4}]};
 }};
 const result=await quarantineStaleClaims({database,olderThanMinutes:3});
 assert.deepEqual(result.rows,[{id:4}]);
});

const prodEnv={
 ...env,
 PR395_STAGING_MODE:"false",
 PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED:"false",
 PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"false",
 WHATSAPP_PAID_SECONDARY_MANUAL_SYNC_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_MANUAL_SYNC_OPERATOR_APPROVED:"true",
 WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_HISTORY_OPERATOR_APPROVED:"true",
 WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED:"true",
 WHATSAPP_APP_SECRET:"synthetic-only-not-a-real-meta-secret-123456",
 META_APP_SECRET:"synthetic-only-not-a-real-meta-secret-123456",
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_WABA_ID:"1593376338308612",
 WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
 WHATSAPP_SECONDARY_WABA_ID:"222222222222222",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"333333333333333",
 WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"222222222222222",
 WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"333333333333333",
 WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
 WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
 WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
 WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
 WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true"
};
const prodInput={...input,wabaId:prodEnv.WHATSAPP_SECONDARY_WABA_ID,
 phoneNumberId:prodEnv.WHATSAPP_SECONDARY_PHONE_NUMBER_ID};
test("production once-only sync stays OFF until signed history receiver and distinct manual gate are ready",()=>{
 assert.doesNotThrow(()=>assertSafeCommand(prodInput,prodEnv,now));
 for(const [key,value] of [
  ["WHATSAPP_PAID_SECONDARY_MANUAL_SYNC_ENABLED","false"],
  ["WHATSAPP_PAID_SECONDARY_MANUAL_SYNC_OPERATOR_APPROVED","false"],
  ["WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED","false"],
  ["WHATSAPP_PAID_SECONDARY_HISTORY_OWNER_CONSENT_VERIFIED","false"],
  ["WHATSAPP_SECONDARY_EXPECTED_PHONE_E164","+60189990000"],
  ["WHATSAPP_SECONDARY_WABA_ID",prodEnv.WHATSAPP_WABA_ID],
  ["WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED","true"],
  ["WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED","true"],
  ["WHATSAPP_SECONDARY_AI_MEDIA_ENABLED","true"],
  ["WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED","true"],
  ["PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED","true"]
 ])assert.throws(()=>assertSafeCommand(prodInput,{...prodEnv,[key]:value},now),key);
 assert.throws(()=>assertSafeCommand({...prodInput,historyConsent:false},prodEnv,now),/consent/);
 assert.throws(()=>assertSafeCommand({...prodInput,phoneNumberId:prodEnv.WHATSAPP_PHONE_NUMBER_ID},prodEnv,now),/pinned/);
});
test("production sender must be active before a one-time claim or external call",async()=>{
 let calls=0;
 const database={async query(sql){
  assert.match(sql,/SELECT id FROM whatsapp_sender_accounts/);
  return {rows:[]};
 }};
 await assert.rejects(()=>dispatchOnce(prodInput,{env:prodEnv,database,now,
  loadCredential:async()=>({accessToken:"synthetic",wabaId:prodInput.wabaId,phoneNumberId:prodInput.phoneNumberId}),
  fetchImpl:async()=>{calls++;throw Error("should not call Meta");}
 }),/not verified and registered/);
 assert.equal(calls,0);
});
test("production exact sender sends only explicitly approved one-time history request",async()=>{
 const database=db();let calls=0;
 const prodToken=async()=>({accessToken:"synthetic",wabaId:prodInput.wabaId,
  phoneNumberId:prodInput.phoneNumberId});
 const options={database,env:prodEnv,now,loadCredential:prodToken,
  fetchImpl:async(url,opts)=>{
   calls++;
   assert.match(url,/\/333333333333333\/smb_app_data$/);
   assert.equal(opts.method,"POST");
   assert.equal(JSON.parse(opts.body).sync_type,"history");
   return response(200,{messaging_product:"whatsapp",request_id:"fake-request-id"});
  }};
 const result=await dispatchOnce(prodInput,options);
 assert.equal(result.state,"accepted");
 assert.equal(calls,1);
 assert.equal(database.queries.filter(q=>q.sql.startsWith("SELECT id FROM whatsapp_sender_accounts")).length,1);
 await assert.rejects(()=>dispatchOnce(prodInput,options),/already reserved/);
 assert.equal(calls,1);
});
