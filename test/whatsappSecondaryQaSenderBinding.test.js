"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const binding=require("../src/services/whatsappSecondaryQaSenderBinding");
function env(extra={}){return{
  WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"false",
  WHATSAPP_APP_SECRET:"x".repeat(32),
  META_APP_SECRET:"x".repeat(32),
  WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"v".repeat(32),
  WHATSAPP_WABA_ID:"1593376338308612",
  WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
  WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+601130535053",
  WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164:"+60129998888",
  WHATSAPP_PAID_DEFAULT_QA_DATABASE_URL:
    "postgresql://qa:secret@ep-qa.ap-southeast-1.aws.neon.tech/neondb",
  WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-qa.ap-southeast-1.aws.neon.tech",
  DATABASE_URL:"postgresql://prod:secret@ep-prod.ap-southeast-1.aws.neon.tech/neondb",
  WHATSAPP_PAID_SECONDARY_QA_WABA_ID:"889900",
  WHATSAPP_PAID_SECONDARY_QA_PHONE_ID:"112233",
  WHATSAPP_PAID_SECONDARY_QA_EXPECTED_E164:"+60129998888",
  WHATSAPP_PAID_SECONDARY_QA_OPERATOR_APPROVED:"true",
  WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"true",
  WHATSAPP_PAID_SECONDARY_QA_HISTORY_CONSENT_VERIFIED:"true",
  WHATSAPP_PAID_SECONDARY_QA_CAPTURE_KEY_B64:Buffer.alloc(32,7).toString("base64"),
  ...extra
};}
function proof(extra={}){return{
  wabaId:"889900",phoneNumberId:"112233",
  displayPhoneNumber:"+60129998888",
  finishEvent:"FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
  graphWabaPhoneOwnershipVerified:true,
  isOnBizApp:true,platformType:"CLOUD_API",
  operatorApproved:true,...extra
};}
function db(existing=[]){
  let calls=[],released=0;
  return{calls,get released(){return released;},
    async connect(){return{
      async query(sql,params){
        calls.push({sql,params});
        if(sql.includes("FROM schema_migrations"))return{rows:[
          {version:102,name:"whatsapp_coexistence_preidentity_events"},
          {version:103,name:"whatsapp_legacy_lifecycle_relay_audit"},
          {version:104,name:"whatsapp_coexistence_once_only_and_lifecycle_alerts"}]};
        if(sql.includes("FROM whatsapp_sender_accounts FOR UPDATE"))return{rows:existing};
        if(sql.startsWith("INSERT INTO whatsapp_sender_accounts"))
          return{rows:[{id:777,sender_key:"coexistence_qa",state:"testing"}]};
        return{rows:[]};
      },release(){released++;}
    };}
  };
}
test("sender binding requires verified Meta ownership and never accepts primary ID",()=>{
  for(const bad of [
    {graphWabaPhoneOwnershipVerified:false},
    {operatorApproved:false},
    {finishEvent:"not_finished"},
    {isOnBizApp:false},
    {platformType:"ON_PREM"},
    {wabaId:"1593376338308612"},
    {phoneNumberId:"1408739622311791"},
    {displayPhoneNumber:"+601130535053"}
  ]) assert.throws(()=>binding.validated(proof(bad),env()),/verified Meta/);
});
test("binds exact secondary in QA while HTTP capture flag remains disabled",async()=>{
  const database=db();
  const e=env();
  const result=await binding.bindQaSender(proof(),{env:e,database});
  assert.equal(e.WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED,"false");
  assert.deepEqual(result,{qaOnly:true,bound:true,senderState:"testing"});
  assert.ok(database.calls.some(x=>x.sql.includes("INSERT INTO whatsapp_sender_accounts")));
  assert.equal(database.calls.at(-1).sql,"COMMIT");
  assert.equal(database.released,1);
});
test("foreign QA sender fails closed and rolls back",async()=>{
  const database=db([{sender_key:"foreign",meta_account_id:"543",meta_phone_number_id:"555"}]);
  await assert.rejects(binding.bindQaSender(proof(),{env:env(),database}),/different sender/);
  assert.equal(database.calls.at(-1).sql,"ROLLBACK");
});
test("verified binding is impossible with missing or mismatched QA host/consent",async()=>{
  const database=db();
  await assert.rejects(binding.bindQaSender(proof(),{
    env:env({WHATSAPP_PAID_DEFAULT_QA_DATABASE_HOST:"ep-other.neon.tech"}),database
  }),/QA Neon host/);
  await assert.rejects(binding.bindQaSender(proof(),{
    env:env({WHATSAPP_PAID_SECONDARY_QA_PROCESSING_CONSENT_VERIFIED:"false"}),database
  }),/consent/);
  assert.equal(database.calls.length,0);
});
