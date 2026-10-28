"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {clinicSecondNumberApproved,verifiedRehearsalTarget,stagingWebhookGuard,
 assertPr395StagingSafety}=require("../src/services/pr395StagingSafety");
const preidentity=require("../src/services/pr395PreidentityReceiver");
const {assertSafeCommand}=require("../src/services/pr395CoexistenceSyncDispatcher");
const CLINIC="+60174831336";
const S="safe-staging-only-meta-app-secret-1234567890";
const base={
 PR395_STAGING_MODE:"true",NODE_ENV:"production",
 PR395_STAGING_BASIC_AUTH_ENABLED:"true",
 PR395_STAGING_BASIC_AUTH_USERNAME:"qa-operator",
 PR395_STAGING_BASIC_AUTH_PASSWORD:S,SESSION_SECRET:S,
 WHATSAPP_APP_SECRET:S,META_APP_SECRET:S,
 DATABASE_URL:"postgresql://synthetic:password@ep-synthetic.aws.neon.tech/neondb",
 PR395_STAGING_EXPECTED_DATABASE_HOST:"ep-synthetic.aws.neon.tech",
 WHATSAPP_WABA_ID:"1593376338308612",
 WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
 WHATSAPP_PHONE_NUMBER:"+601130535053",
 WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
 WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:CLINIC,
 PR395_STAGING_APPROVED_TEST_PHONE_E164:CLINIC,
 PR395_STAGING_REAL_CLINIC_ENABLED:"true",
 PR395_STAGING_REAL_CLINIC_OPERATOR_APPROVED:"true",
 PR395_STAGING_REAL_CLINIC_E164_PIN:CLINIC,
};
function senderEnv(overrides={}){
 return{...base,
  PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"true",
  PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"true",
  WHATSAPP_SECONDARY_WABA_ID:"888887777777",
  WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"888887777777",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_TOKEN:"qa-only-inert-credential",
  WHATSAPP_TOKEN:"pr395-inert-primary",
  WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
  WHATSAPP_COEXISTENCE_ENABLED:"true",
  WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
  WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
  WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true",
  ...overrides};
}
test("real clinic requires separate staging switch, operator approval and exact pin",()=>{
 assert.equal(clinicSecondNumberApproved(base),true);
 assert.deepEqual(verifiedRehearsalTarget(senderEnv()),{
  waba:"888887777777",phone:"1318355951360575",e164:CLINIC
 });
 assert.deepEqual(assertPr395StagingSafety(senderEnv()),{
  staging:true,workersDisabled:true,providerProcessingDisabled:false,historyImporterOnly:true
 });
 for(const o of [
   {PR395_STAGING_MODE:"false"},
   {PR395_STAGING_REAL_CLINIC_ENABLED:"false"},
   {PR395_STAGING_REAL_CLINIC_OPERATOR_APPROVED:"false"},
   {PR395_STAGING_REAL_CLINIC_E164_PIN:"+60123000000"},
   {PR395_STAGING_APPROVED_TEST_PHONE_E164:"+60123000000"},
   {WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60123000000"},
   {WHATSAPP_SECONDARY_WABA_ID:"1593376338308612"},
   {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1408739622311791"},
   {WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"},
   {WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true"},
   {WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true"},
   {WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true"},
   {WHATSAPP_TOKEN:"real-primary-production-token"},
 ])assert.throws(()=>assertPr395StagingSafety(senderEnv(o)),Error,JSON.stringify(o));
});
test("clinic preidentity accepts only signed-route lifecycle shape with no pinned ID before onboarding",()=>{
 const e={...base,PR395_STAGING_PREIDENTITY_RECEIVER_ENABLED:"true",
  WHATSAPP_SECONDARY_WABA_ID:"",WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"",
  WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"",
  PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"false",
  PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"false",
  WHATSAPP_TOKEN:"pr395-inert-primary"
 };
 assert.equal(preidentity.enabled(e),true);
 assert.deepEqual(assertPr395StagingSafety(e),{
  staging:true,workersDisabled:true,providerProcessingDisabled:true
 });
 const signedParsed={object:"whatsapp_business_account",entry:[{
  id:"888887777777",time:1800000000,
  changes:[{field:"account_update",value:{
   event:"ACCOUNT_CONNECTED",phone_number:CLINIC
  }}]
 }]};
 assert.equal(preidentity.inspectPreidentityBatch(signedParsed,e).length,1);
 for(const o of [
   {PR395_STAGING_REAL_CLINIC_ENABLED:"false"},
   {PR395_STAGING_REAL_CLINIC_OPERATOR_APPROVED:"false"},
   {PR395_STAGING_REAL_CLINIC_E164_PIN:"+60129990000"},
   {WHATSAPP_SECONDARY_WABA_ID:"888887777777"},
 ])assert.equal(preidentity.enabled({...e,...o}),false);
 for(const body of [
   {...signedParsed,entry:[{...signedParsed.entry[0],id:"1593376338308612"}]},
   {...signedParsed,entry:[{...signedParsed.entry[0],changes:[{
    field:"history",value:{metadata:{phone_number_id:"1318355951360575"}}
   }]}]},
   {...signedParsed,entry:[{...signedParsed.entry[0],changes:[{
    field:"account_update",value:{event:"ACCOUNT_CONNECTED",phone_number:"+60129990000"}
   }]}]}
 ])assert.throws(()=>preidentity.inspectPreidentityBatch(body,e));
});
test("clinic history request stays one-time, consented and owner-verified",()=>{
 const now=new Date("2026-10-28T11:00:00Z");
 const e={...senderEnv(),
  PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED:"true"
 };
 const i={onboardingAttemptId:9,wabaId:"888887777777",phoneNumberId:"1318355951360575",
  syncType:"history",onboardingCompletedAt:"2026-10-28T10:00:00Z",
  operatorApproved:true,receiverReady:true,importerReady:true,
  verifiedAppSubscription:true,verifiedCallbackOverride:true,
  syncConsent:true,historyConsent:true,
  consentSource:"embedded_signup_owner",consentVerifiedBy:"clinic_owner"};
 assert.doesNotThrow(()=>assertSafeCommand(i,e,now));
 for(const x of [
  {historyConsent:false},{receiverReady:false},{verifiedCallbackOverride:false},
  {verifiedAppSubscription:false},{operatorApproved:false},
  {onboardingCompletedAt:"2026-10-27T08:00:00Z"}
 ])assert.throws(()=>assertSafeCommand({...i,...x},e,now));
 assert.throws(()=>assertSafeCommand(i,{...e,PR395_STAGING_REAL_CLINIC_OPERATOR_APPROVED:"false"},now));
});
