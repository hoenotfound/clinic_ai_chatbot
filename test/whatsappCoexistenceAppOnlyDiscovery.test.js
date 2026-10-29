"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  publicConfig,
  requireExpectedSecondaryPhone,
  unassignedProtectedQaTarget,
  unassignedProtectedProductionTarget,
  assertExpectedSecondaryPhone,
  completeEmbeddedSignup,
} = require("../src/services/whatsappCoexistenceOnboardingService");

function qa(overrides = {}) {
  return {
    META_APP_ID: "test-app", META_APP_SECRET: "test-app-secret",
    META_EMBEDDED_SIGNUP_CONFIG_ID: "test-config",
    META_EMBEDDED_SIGNUP_V4_CONFIRMED: "true", WHATSAPP_VERIFY_TOKEN: "test-verify",
    WHATSAPP_SECONDARY_SENDER_KEY: "coexistence_qa",
    WHATSAPP_SECONDARY_PHONE_NUMBER_ID: "",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID: "",
    WHATSAPP_SECONDARY_WABA_ID: "",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_E164: "+60120000000",
    PR395_STAGING_APPROVED_TEST_PHONE_E164: "+60120000000",
    PR395_STAGING_MODE: "true",
    PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    PR395_STAGING_APP_ONLY_SIGNUP_READY: "true",
    PR395_STAGING_PRE_SIGNUP_CALLBACK_REHEARSED: "true",
    PR395_STAGING_APP_DEFAULT_LIFECYCLE_REHEARSED: "true",
    PR395_STAGING_HISTORY_IMPORT_TRANSITION_REHEARSED: "true",
    PR395_STAGING_PROVIDER_REHEARSAL_ENABLED: "false",
    PR395_STAGING_ALLOW_PROVIDER_PROCESSING: "false",
    WHATSAPP_PHONE_NUMBER_ID: "111111111111111",
    WHATSAPP_PHONE_NUMBER: "+60121111111",
    ...overrides,
  };
}
function finish(data = {}) {
  return {type: "WA_EMBEDDED_SIGNUP",event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
    version:3,data:{waba_id:"222222222222222",...data}};
}
function metaFetch(phoneDisplay = "+60 12-000 0000") {
  const calls = [];
  return {calls, async fetch(url, options = {}) {
    const request = String(url);
    calls.push({request, method: options.method || "GET"});
    const reply = (body,status=200)=>({ok:status===200,status,json:async()=>body});
    if(request.endsWith("/oauth/access_token")) {
      assert.equal(options.method,"POST");
      return reply({access_token:"test-authorized-token"});
    }
    if(request.includes("/debug_token?")) return reply({data:{
      is_valid:true,app_id:"test-app",scopes:["whatsapp_business_management","whatsapp_business_messaging"]
    }});
    if(request.includes("/222222222222222?fields=id,name")) return reply({
      id:"222222222222222",name:"Personal QA"
    });
    if(request.includes("/222222222222222/phone_numbers?")) return reply({data:[{
      id:"333333333333333",display_phone_number:phoneDisplay,verified_name:"QA"
    }]});
    if(request.includes("/333333333333333?fields=is_on_biz_app,platform_type")) return reply({
      id:"333333333333333",is_on_biz_app:true,platform_type:"CLOUD_API"
    });
    throw Error("Unexpected Meta endpoint in QA mock.");
  }};
}

test("Business App-only personal QA target may open Embedded Signup without a guessed Meta phone ID",()=>{
  const source = qa();
  assert.equal(unassignedProtectedQaTarget(source),true);
  assert.equal(publicConfig(source).configured,true);
  assert.equal(publicConfig(source).onboardingPhases.beforeQr.ready,true);
  assert.equal(publicConfig(source).onboardingPhases.afterQr.onceOnlyHistorySyncAutomatic,false);
  assert.equal(publicConfig(source).onboardingPhases.afterQr.requiresSeparateOwnerHistoryConsent,true);
  // Synthetic rehearsals never imply QR approval or live provider proof.
  assert.equal(publicConfig(qa({PR395_STAGING_APP_ONLY_SIGNUP_READY:"false"})).configured,false);
  for(const flag of [
    "PR395_STAGING_PRE_SIGNUP_CALLBACK_REHEARSED",
    "PR395_STAGING_APP_DEFAULT_LIFECYCLE_REHEARSED",
    "PR395_STAGING_HISTORY_IMPORT_TRANSITION_REHEARSED"
  ]){
    const unsafe=qa({[flag]:"false"});
    assert.equal(unassignedProtectedQaTarget(unsafe),false);
    assert.equal(publicConfig(unsafe).configured,false);
    assert.ok(publicConfig(unsafe).missing.some(x=>x.includes(flag)));
  }
  // Legacy VERIFIED cannot be substituted for separately attested rehearsals.
  assert.equal(publicConfig(qa({
    PR395_STAGING_APP_DEFAULT_LIFECYCLE_REHEARSED:"false",
    PR395_STAGING_APP_DEFAULT_LIFECYCLE_VERIFIED:"true"
  })).configured,false);
  assert.equal(publicConfig(qa({
    PR395_STAGING_PRE_SIGNUP_CALLBACK_REHEARSED:"false"
  })).missing.some(x=>x.includes("PR395_STAGING_PRE_SIGNUP_CALLBACK_REHEARSED")),true);
  assert.equal(publicConfig(qa({
    PR395_STAGING_HISTORY_IMPORT_TRANSITION_REHEARSED:"false"
  })).missing.some(x=>x.includes("PR395_STAGING_HISTORY_IMPORT_TRANSITION_REHEARSED")),true);
  // A pre-signup personal Business App number has no assigned Meta phone ID.
  // Both IDs being absent must not be mistaken for matching account IDs.
  assert.equal(publicConfig(qa({WHATSAPP_PHONE_NUMBER_ID:""})).configured,true);
  assert.equal(publicConfig(qa({WHATSAPP_PHONE_NUMBER_ID:""})).missing.includes("A distinct secondary phone number ID"),false);
  // A real matching, nonempty phone ID must still fail closed.
  assert.equal(publicConfig(qa({WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"111111111111111"})).configured,false);
  assert.equal(publicConfig(source).runtime.phoneNumberId,null);
  assert.equal(publicConfig(source).runtime.expectedPhoneNumberId,null);
  assert.equal(requireExpectedSecondaryPhone(source),null);
  // Missing encryption key blocks signup authorization, but it does not
  // retroactively make the intended QA phone identity invalid.
  assert.equal(unassignedProtectedQaTarget(qa({
    PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:""
  })),true);
  assert.equal(publicConfig(qa({
    PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY:""
  })).configured,false);
  for (const override of [
    {PR395_STAGING_PRE_SIGNUP_CALLBACK_REHEARSED:"false"},
    {PR395_STAGING_APP_DEFAULT_LIFECYCLE_REHEARSED:"false"},
    {PR395_STAGING_HISTORY_IMPORT_TRANSITION_REHEARSED:"false"},
    {PR395_STAGING_APP_ONLY_SIGNUP_READY:"false"},
    {PR395_STAGING_APP_ONLY_SIGNUP_READY:""},
    {PR395_STAGING_MODE:"false"},
    {PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"true"},
    {PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"true"},
    {PR395_STAGING_APPROVED_TEST_PHONE_E164:""},
    {PR395_STAGING_APPROVED_TEST_PHONE_E164:"+60129999999"},
    {WHATSAPP_SECONDARY_SENDER_KEY:"tcm_wellness"},
    {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575"},
    {WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
      PR395_STAGING_APPROVED_TEST_PHONE_E164:"+60174831336"},
  ]) {
    const unsafe=qa(override);
    assert.equal(unassignedProtectedQaTarget(unsafe),false);
    assert.equal(publicConfig(unsafe).configured,false);
  }
});
test("pre-ID onboarding accepts only Graph-verified owning WABA and matching E164, without registration",async()=>{
  const meta=metaFetch();
  const result=await completeEmbeddedSignup({
    code:"single-use-code",sessionInfo:finish(),env:qa(),fetchImpl:meta.fetch,
  });
  assert.equal(result.waba.id,"222222222222222");
  assert.equal(result.phone.id,"333333333333333");
  assert.equal(result.phone.displayPhoneNumber,"+60 12-000 0000");
  assert.equal(result.runtime.targetMode,"secondary");
  assert.equal(result.runtime.phoneNumberId,null);
  assert.equal(result.activationRequired,true);
  assert.equal(JSON.stringify(result).includes("test-authorized-token"),false);
  assert.equal(meta.calls.some(x=>/\/register(?:\?|$)/.test(x.request)),false);
  assert.equal(meta.calls.some(x=>x.request.includes("/subscribed_apps")),false);
});
test("wrong discovered App number or primary phone must be rejected before recording authorization",async()=>{
  const wrong=metaFetch("+60 12-999 9999");
  await assert.rejects(completeEmbeddedSignup({
    code:"single-use-code",sessionInfo:finish(),env:qa(),fetchImpl:wrong.fetch,
  }),x=>x.code==="WHATSAPP_COEXISTENCE_SECONDARY_DISPLAY_MISMATCH");
  assert.throws(()=>assertExpectedSecondaryPhone({
    id:"111111111111111",displayPhoneNumber:"+60120000000"
  },qa()),x=>x.code==="WHATSAPP_COEXISTENCE_SECONDARY_PHONE_MISMATCH");
  assert.throws(()=>assertExpectedSecondaryPhone({
    id:"1318355951360575",displayPhoneNumber:"+60120000000"
  },qa()),x=>x.code==="WHATSAPP_COEXISTENCE_SECONDARY_PHONE_MISMATCH");
});

test("validated secondary signup gives verified system token only to internal vault callback",async()=>{
  const graph=metaFetch();
  let received=null;
  const result=await completeEmbeddedSignup({
    code:"single-use-code",sessionInfo:finish(),env:qa(),fetchImpl:graph.fetch,
    onVerifiedCredential:async data=>{ received=data; },
  });
  assert.equal(received.accessToken,"test-authorized-token");
  assert.equal(received.wabaId,"222222222222222");
  assert.equal(received.phoneNumberId,"333333333333333");
  assert.equal(JSON.stringify(result).includes(received.accessToken),false);
  assert.equal(JSON.stringify(result.permissions).includes(received.accessToken),false);
  assert.equal(result.activationRequired,true);
});
test("wrong phone never gives a credential to the internal vault callback",async()=>{
  const graph=metaFetch("+60 12-999 9999");
  let callbacks=0;
  await assert.rejects(completeEmbeddedSignup({
    code:"single-use-code",sessionInfo:finish(),env:qa(),fetchImpl:graph.fetch,
    onVerifiedCredential:async()=>{callbacks++;},
  }),error=>error.code==="WHATSAPP_COEXISTENCE_SECONDARY_DISPLAY_MISMATCH");
  assert.equal(callbacks,0);
});

function productionClinic(overrides={}) {
  return qa({
    PR395_STAGING_MODE:"false",
    PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"false",
    PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"false",
    PR395_STAGING_APP_ONLY_SIGNUP_READY:"false",
    PR395_STAGING_PRE_SIGNUP_CALLBACK_REHEARSED:"false",
    PR395_STAGING_APP_DEFAULT_LIFECYCLE_REHEARSED:"false",
    PR395_STAGING_HISTORY_IMPORT_TRANSITION_REHEARSED:"false",
    WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
    WHATSAPP_WABA_ID:"999999999999999",
    WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
    WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
    WHATSAPP_SECONDARY_PRE_QR_ID_DISCOVERY_ENABLED:"true",
    WHATSAPP_SECONDARY_PRE_QR_RECEIVER_REHEARSED:"true",
    WHATSAPP_SECONDARY_PRE_QR_OWNER_APPROVED:"true",
    WHATSAPP_SECONDARY_PRODUCTION_VAULT_ENABLED:"true",
    WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,9).toString("base64"),
    WHATSAPP_COEXISTENCE_ENABLED:"false",
    WHATSAPP_SECONDARY_TOKEN:"",
    ...overrides
  });
}

test("real Neutro pre-QR discovery refuses activation by default or a mismatched phone",()=>{
  const prepared=productionClinic();
  assert.equal(unassignedProtectedProductionTarget(prepared),true);
  assert.equal(requireExpectedSecondaryPhone(prepared),null);
  assert.equal(publicConfig(prepared).configured,true);
  assert.equal(publicConfig(prepared).onboardingPhases.afterQr.onceOnlyHistorySyncAutomatic,false);
  assert.equal(publicConfig(prepared).onboardingPhases.afterQr.requiresSeparateOwnerHistoryConsent,true);
  assert.equal(publicConfig(productionClinic({WHATSAPP_SECONDARY_PRE_QR_OWNER_APPROVED:"false"})).configured,false);
  for(const unsafe of [
    {WHATSAPP_SECONDARY_PRE_QR_ID_DISCOVERY_ENABLED:"false"},
    {WHATSAPP_SECONDARY_PRE_QR_RECEIVER_REHEARSED:"false"},
    {WHATSAPP_SECONDARY_PRODUCTION_VAULT_ENABLED:"false"},
    {WHATSAPP_SECONDARY_PRE_QR_OWNER_APPROVED:"false"},
    {WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60120000000"},
    {WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60121111111"},
    {WHATSAPP_PHONE_NUMBER:"+60174831336"},
    {WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa"},
    {WHATSAPP_SECONDARY_SENDER_KEY:"neutro"},
    {WHATSAPP_PRIMARY_SENDER_KEY:"other"},
    {WHATSAPP_PHONE_NUMBER:"+60174831336"},
    {WHATSAPP_PHONE_NUMBER_ID:""},
    {WHATSAPP_WABA_ID:""},
    {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575"},
    {WHATSAPP_SECONDARY_WABA_ID:"333333333333333"},
    {WHATSAPP_SECONDARY_TOKEN:"must-stay-absent"},
    {WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true"},
    {WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"},
    {WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true"},
    {WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true"},
    {WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true"},
    {WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true"},
    {WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true"},
    {WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true"},
    {PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED:"true"},
    {WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY:""},
    {WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,7).toString("base64")},
    {WHATSAPP_COEXISTENCE_ENABLED:"true"},
    {PR395_STAGING_MODE:"true"},
    {META_EMBEDDED_SIGNUP_V4_CONFIRMED:"false"}
  ]) {
    const env=productionClinic(unsafe);
    assert.equal(unassignedProtectedProductionTarget(env),false,JSON.stringify(unsafe));
    assert.equal(publicConfig(env).configured,false,JSON.stringify(unsafe));
  }
});

test("pre-QR Meta lookup verifies exact real number before credential callback, never sends",async()=>{
  const real=metaFetch("+60 17-483 1336");
  let captured=null;
  const result=await completeEmbeddedSignup({
    code:"single-use-code",sessionInfo:finish(),
    env:productionClinic(),fetchImpl:real.fetch,
    onVerifiedCredential:async value=>{captured=value;}
  });
  assert.equal(result.phone.displayPhoneNumber,"+60 17-483 1336");
  assert.equal(result.runtime.targetMode,"secondary");
  assert.equal(result.runtime.phoneNumberId,null);
  assert.equal(result.activationRequired,true);
  assert.equal(captured.phoneNumberId,"333333333333333");
  assert.equal(JSON.stringify(result).includes("test-authorized-token"),false);
  assert.equal(real.calls.some(x=>/\/register(?:\?|$)/.test(x.request)),false);
  assert.equal(real.calls.some(x=>x.request.includes("/subscribed_apps")),false);

  let callbacks=0;
  const wrong=metaFetch("+60 12-000 0000");
  await assert.rejects(completeEmbeddedSignup({
    code:"single-use-code",sessionInfo:finish(),
    env:productionClinic(),fetchImpl:wrong.fetch,
    onVerifiedCredential:async()=>{callbacks++;}
  }),x=>x.code==="WHATSAPP_COEXISTENCE_SECONDARY_DISPLAY_MISMATCH");
  assert.equal(callbacks,0);
  assert.throws(()=>assertExpectedSecondaryPhone({
    id:"111111111111111",displayPhoneNumber:"+60 17-483 1336"
  },productionClinic()),x=>x.code==="WHATSAPP_COEXISTENCE_SECONDARY_PHONE_MISMATCH");
});

test("separate production Coexistence vault encrypts only the pinned Neutro secondary token",()=>{
  const {sealCredential,openCredential,credentialVaultReady}=
    require("../src/services/whatsappCoexistenceCredentialVault");
  const input={
    attemptId:51,wabaId:"222222222222222",phoneNumberId:"333333333333333",
    accessToken:"synthetic-neutro-secondary-long-token"
  };
  const env=productionClinic();
  assert.equal(credentialVaultReady(env),true);
  const sealed=sealCredential({...input,env});
  assert.equal(openCredential({...sealed,attemptId:51,wabaId:input.wabaId,
    phoneNumberId:input.phoneNumberId,env}),input.accessToken);
  assert.throws(()=>openCredential({...sealed,attemptId:51,
    wabaId:input.wabaId,phoneNumberId:input.phoneNumberId,env:qa()}));
  for(const override of [
    {WHATSAPP_SECONDARY_PRODUCTION_VAULT_ENABLED:"false"},
    {WHATSAPP_SECONDARY_SENDER_KEY:"neutro"},
    {WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa"},
    {WHATSAPP_PRIMARY_SENDER_KEY:"unexpected"},
    {WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60120000000"},
    {WHATSAPP_PHONE_NUMBER:"+60174831336"},
    {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"111111111111111"},
    {WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY:""},
    {WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY:env.PR395_COEXISTENCE_TOKEN_ENCRYPTION_KEY}
  ]) {
    const forbidden=productionClinic(override);
    assert.equal(credentialVaultReady(forbidden),false,JSON.stringify(override));
    assert.throws(()=>sealCredential({...input,env:forbidden}),undefined,
      JSON.stringify(override));
  }
});
