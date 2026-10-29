"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {recheck}=require("../src/services/neutroSecondaryCoexistenceStatusRecheck");
const env={
 PR395_STAGING_MODE:"false",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
 WHATSAPP_SECONDARY_WABA_ID:"222222222222222",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"333333333333333",
 WHATSAPP_WABA_ID:"1593376338308612",
 WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
 WHATSAPP_PHONE_NUMBER:"+601130535053",
};
const scope={attemptId:44,wabaId:env.WHATSAPP_SECONDARY_WABA_ID,
 phoneNumberId:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID};
function fake({ready=true,matching=true}={}){
 const calls=[];
 const database={query:async(sql,args)=>{
   calls.push({sql,args});
   if(sql.startsWith("SELECT id,display_phone_number"))
     return {rows:[{id:44,display_phone_number:"+60 17-483 1336"}]};
   if(sql.startsWith("UPDATE whatsapp_coexistence_onboarding_attempts"))
     return {rows:[{id:44}],rowCount:1};
   throw Error("Unexpected SQL");
 }};
 const loadCredential=async(q)=>{assert.deepEqual(q,{wabaId:scope.wabaId,phoneNumberId:scope.phoneNumberId});return{accessToken:"synthetic-private-credential"};};
 const lookupPhones=async({wabaId,accessToken})=>{
   assert.equal(wabaId,scope.wabaId);
   assert.equal(accessToken,"synthetic-private-credential");
   return [{id:scope.phoneNumberId,
     displayPhoneNumber:matching?"+60 17-483 1336":"+60 12-000 0000",
     isOnBizApp:ready,platformType:ready?"CLOUD_API":"ON_PREMISE",
     coexistenceReady:ready}];
 };
 return {database,loadCredential,lookupPhones,calls};
}
test("delayed Meta Coexistence status cannot falsely promote an attempt",async()=>{
 const deps=fake({ready:false});
 const result=await recheck({...scope,execute:false},{env,...deps});
 assert.deepEqual(result,{ready:false,updated:false,reason:"Meta Coexistence status not propagated"});
 assert.equal(deps.calls.filter(x=>x.sql.startsWith("UPDATE")).length,0);
});
test("verified status defaults to dry-run without mutating the onboarding audit",async()=>{
 const deps=fake();
 const result=await recheck({...scope,execute:false},{env,...deps});
 assert.deepEqual(result,{ready:true,updated:false,dryRun:true});
 assert.equal(deps.calls.filter(x=>x.sql.startsWith("UPDATE")).length,0);
});
test("status update requires operator approval and exact credential-backed attempt",async()=>{
 const deps=fake();
 await assert.rejects(recheck({...scope,execute:true},{env,...deps}),
   /separate operator approval/);
 assert.equal(deps.calls.length,0);
 const result=await recheck({...scope,execute:true},{
   env:{...env,WHATSAPP_SECONDARY_STATUS_RECHECK_OPERATOR_APPROVED:"true"},...deps
 });
 assert.deepEqual(result,{ready:true,updated:true,attemptId:44});
 const update=deps.calls.find(x=>x.sql.startsWith("UPDATE"));
 assert.ok(update.sql.includes("EXISTS (SELECT 1 FROM whatsapp_coexistence_onboarding_credentials"));
 assert.deepEqual(update.args,[44,scope.wabaId,scope.phoneNumberId,"60174831336"]);
});
test("wrong phone, WABA, business number, and Meta phone ownership fail closed",async()=>{
 for(const change of [
   {phoneNumberId:env.WHATSAPP_PHONE_NUMBER_ID},
   {wabaId:env.WHATSAPP_WABA_ID},
   {phoneNumberId:"111111111111111"},
 ]) {
   const deps=fake();
   await assert.rejects(recheck({...scope,...change},{env,...deps}));
   assert.equal(deps.calls.length,0);
 }
 const wrong=fake({matching:false});
 await assert.rejects(recheck(scope,{env,...wrong}),/does not match/);
 assert.equal(wrong.calls.filter(x=>x.sql.startsWith("UPDATE")).length,0);
});
