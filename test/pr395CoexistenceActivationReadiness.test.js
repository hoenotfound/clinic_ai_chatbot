"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {
  inspectPr395CoexistenceReadiness,REQUIRED_META_FIELDS
}=require("../src/services/pr395CoexistenceActivationReadiness");

function env(){
 return{
   PR395_STAGING_MODE:"true",
   WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
   WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60120000000",
   PR395_STAGING_APPROVED_TEST_PHONE_E164:"+60120000000",
   WHATSAPP_PHONE_NUMBER:"+60128881111",
   WHATSAPP_WABA_ID:"111111111111111",
   WHATSAPP_PHONE_NUMBER_ID:"222222222222222",
   META_EMBEDDED_SIGNUP_CONFIG_ID:"synthetic-config",
   META_EMBEDDED_SIGNUP_V4_CONFIRMED:"true",
   PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,5).toString("base64"),
 };
}
function preEvidence(){
 return{
   confirmedMetaFields:[...REQUIRED_META_FIELDS],
   preSignupCallbackSafetyProven:true,
   appDefaultLifecycleSafetyProven:true,
   importerTransitionRehearsed:true,
 };
}
function postEvidence(){
 return{
   wabaId:"333333333333333",phoneNumberId:"444444444444444",
   graphWabaPhoneOwnershipVerified:true,isOnBizApp:true,platformType:"CLOUD_API",
   senderScopedUnexpiredTokenVerified:true,signedReceiverAcceptanceVerified:true,
   wabaOverrideMatchesStaging:true,appDefaultLifecycleSafetyProven:true,
   importerReady:true,oneTimeSyncAlreadyTriggered:false,
   ownerSyncApproval:true,historyConsent:true,
   onboardingCompletedAt:"2026-10-27T02:00:00Z",
 };
}
const now=new Date("2026-10-27T02:20:00Z");
test("current protected stage cannot approve QR based on Render Live or mocked CI",()=>{
 const v=inspectPr395CoexistenceReadiness({env:env(),evidence:{
   confirmedMetaFields:[...REQUIRED_META_FIELDS]
 },now});
 assert.equal(v.qr.preflightComplete,false);
 assert.ok(v.qr.missing.includes("receiver_pre_signup_catch_path_rehearsed"));
 assert.ok(v.qr.missing.includes("default_callback_lifecycle_route_rehearsed"));
 assert.equal(v.sync.preflightComplete,false);
 assert.deepEqual(v.sync.requests,[]);
 assert.equal(v.automaticNetworkActions,false);
});
test("pre-QR acceptance requires every independent observed evidence item",()=>{
 const accepted=inspectPr395CoexistenceReadiness({env:env(),evidence:preEvidence(),now});
 assert.deepEqual(accepted.qr.missing,[]);
 assert.equal(accepted.qr.preflightComplete,true);
 for(const property of [
   "preSignupCallbackSafetyProven","appDefaultLifecycleSafetyProven",
   "importerTransitionRehearsed"
 ]){
   assert.equal(inspectPr395CoexistenceReadiness({
     env:env(),evidence:{...preEvidence(),[property]:false},now
   }).qr.preflightComplete,false);
 }
 assert.equal(inspectPr395CoexistenceReadiness({
   env:env(),evidence:{...preEvidence(),confirmedMetaFields:["messages"]},now
 }).qr.preflightComplete,false);
});
test("sync requests require sender ownership, override, receiver, explicit approval and 24h",()=>{
 const p=inspectPr395CoexistenceReadiness({
   env:env(),evidence:preEvidence(),afterSignup:postEvidence(),now
 });
 assert.equal(p.sync.preflightComplete,true);
 assert.deepEqual(p.sync.requests.map(x=>x.body.sync_type),[
   "smb_app_state_sync","history"
 ]);
 assert.ok(p.sync.requests.every(x=>x.path==="/444444444444444/smb_app_data"));
 assert.equal(inspectPr395CoexistenceReadiness({
   env:env(),evidence:preEvidence(),afterSignup:{...postEvidence(),historyConsent:false},now
 }).sync.requests.length,1);
 for(const bad of [
   {wabaId:"111111111111111"},{phoneNumberId:"222222222222222"},
   {phoneNumberId:"1318355951360575"},
   {graphWabaPhoneOwnershipVerified:false},{isOnBizApp:false},
   {platformType:"ON_PREMISE"},{senderScopedUnexpiredTokenVerified:false},
   {signedReceiverAcceptanceVerified:false},{wabaOverrideMatchesStaging:false},
   {appDefaultLifecycleSafetyProven:false},{importerReady:false},
   {oneTimeSyncAlreadyTriggered:true},{ownerSyncApproval:false},
 ]){
   const result=inspectPr395CoexistenceReadiness({
     env:env(),evidence:preEvidence(),afterSignup:{...postEvidence(),...bad},now
   });
   assert.equal(result.sync.preflightComplete,false,JSON.stringify(bad));
   assert.deepEqual(result.sync.requests,[]);
 }
 const expired=inspectPr395CoexistenceReadiness({
   env:env(),evidence:preEvidence(),afterSignup:postEvidence(),
   now:new Date("2026-10-28T03:01:00Z")
 });
 assert.equal(expired.sync.preflightComplete,false);
 assert.ok(expired.sync.missing.includes("one_time_24_hour_window"));
});
test("authorization blocked without isolated staging, vault or with outbound enabled",()=>{
 for(const override of [
   {PR395_STAGING_MODE:"false"},
   {WHATSAPP_SECONDARY_SENDER_KEY:"tcm_wellness"},
   {PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:""},
   {WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"},
   {WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true"}
 ]){
   assert.equal(inspectPr395CoexistenceReadiness({
     env:{...env(),...override},evidence:preEvidence(),now
   }).qr.preflightComplete,false);
 }
});
