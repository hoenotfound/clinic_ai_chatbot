"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  publicConfig,
  requireExpectedSecondaryPhone,
  unassignedProtectedQaTarget,
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
