"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {supervisedTestWindow,isSecondarySupervisedAiTextTestEligible}=
  require("../src/services/whatsappSecondarySupervisedAiTextTest");
const {isSecondaryAdsOnlyEligible}=
  require("../src/services/whatsappSecondaryAdsOnlyEligibility");
const {sendSecondaryStaffText}=
  require("../src/services/whatsappSecondaryStaffDispatch");

const NOW=new Date("2026-11-01T15:04:00Z");
const ENABLED={
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"test_only",
  WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_ENABLED:"true",
  WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_CONTACT_ID:"8877",
  WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_STARTS_AT:"2026-11-01T15:00:00Z",
  WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_EXPIRES_AT:"2026-11-01T15:45:00Z",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
  WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
  WHATSAPP_COEXISTENCE_ENABLED:"true",
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
  WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
};

test("supervised mode is disabled by default and cannot admit other contact IDs",async()=>{
  let calls=0;
  const database={query:async()=>{calls++;return{rows:[{eligible:true}]}}};
  for(const e of [{}, {...ENABLED,WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_ENABLED:"false"},
    {...ENABLED,WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only"},
    {...ENABLED,WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_CONTACT_ID:"8864"}]){
    assert.equal(await isSecondarySupervisedAiTextTestEligible(8877,{database,env:e,now:NOW}),false);
  }
  for(const id of [8871,8862,8864,1,"garbage",null]){
    assert.equal(await isSecondarySupervisedAiTextTestEligible(id,{database,env:ENABLED,now:NOW}),false);
  }
  assert.equal(calls,0);
});

test("supervised send requires a short future-bounded UTC window",()=>{
  assert.ok(supervisedTestWindow(ENABLED,NOW));
  for(const override of [
    {WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_STARTS_AT:"2026-11-01"},
    {WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_EXPIRES_AT:"2026-11-01T16:00:01Z"},
    {WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_EXPIRES_AT:"2026-11-01T15:03:59Z"},
    {WHATSAPP_SECONDARY_SUPERVISED_AI_TEXT_TEST_STARTS_AT:"2026-11-01T15:05:00Z"},
    {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1408739622311791"},
    {WHATSAPP_SECONDARY_WABA_ID:"1593376338308612"},
    {WHATSAPP_SECONDARY_SENDER_KEY:"neutro"},
    {WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"false"},
    {WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"false"},
    {WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true"},
    {WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true"},
    {WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"true"},
    {WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true"},
    {WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED:"true"},
    {WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED:"true"},
  ]){
    assert.equal(supervisedTestWindow({...ENABLED,...override},NOW),null,
      JSON.stringify(override));
  }
  assert.equal(supervisedTestWindow(ENABLED,new Date("2026-11-01T15:45:00Z")),null,
    "test cannot send at/after expiry");
  assert.equal(supervisedTestWindow(ENABLED,new Date("2026-11-01T14:59:59Z")),null,
    "test cannot start early");
});

test("only the verified secondary text contact passes the sender-bound database check",async()=>{
  let calls=0;
  const database={query:async(sql,params)=>{
    calls++;
    for(const guard of [
      "sa.id=2","sa.sender_key='neutro_secondary'",
      "sa.meta_phone_number_id='1318355951360575'",
      "sa.meta_account_id='1852014482431209'",
      "sc.state='bound'","c.whatsapp_coexistence_imported_at IS NULL",
      "whatsapp_sender_coexistence_history_messages",
      "c.whatsapp_opt_out_at IS NULL",
      "c.needs_attention=FALSE",
      "m.whatsapp_message_id IS NOT NULL",
      "m.created_at > $2::timestamptz - INTERVAL '24 hours'",
      "primary_sa.sender_key='neutro'",
      "whatsapp_sender_owner_risk_override_audit",
      "o.owner_authorized=TRUE",
      "o.old_message_retry_prohibited=TRUE",
      "c.created_at >= '2026-11-01T15:00:00Z'",
    ])assert.ok(sql.includes(guard),guard);
    assert.deepEqual(params,[8877,NOW.toISOString()]);
    return{rows:[{eligible:true}]};
  }};
  assert.equal(await isSecondarySupervisedAiTextTestEligible(8877,{database,env:ENABLED,now:NOW}),true);
  assert.equal(calls,1);
  assert.equal(await isSecondarySupervisedAiTextTestEligible(8877,{
    database:{query:async()=>({rows:[{eligible:false}]})},env:ENABLED,now:NOW,
  }),false);
  assert.equal(await isSecondarySupervisedAiTextTestEligible(8877,{
    database:{query:async()=>{throw Error("DB unavailable")}},env:ENABLED,now:NOW,
  }),false);
});

test("normal ad-only authorization remains OFF in test_only, including follow-up/media paths",async()=>{
  let calls=0;
  const database={query:async()=>{calls++;return{rows:[{eligible:true}]}}};
  assert.equal(await isSecondaryAdsOnlyEligible(8877,{database,env:ENABLED}),false);
  assert.equal(calls,0);
  const senderFollowups=require("../src/services/whatsappSecondaryFollowUpService");
  const senderMedia=require("../src/services/whatsappSecondaryAiMediaQueue");
  assert.match(senderFollowups.CANDIDATES_SQL,/whatsapp_free_entry_referrals ads_ref/);
  assert.match(senderMedia.READY_SQL,/whatsapp_free_entry_referrals ads_ref/);
  assert.equal(senderFollowups.enabled(ENABLED),false);
});

test("supervised AI text may reach normal policy check but not bypass it or call Meta",async()=>{
  let providerCalls=0,queries=0,policies=0;
  const database={query:async()=>{queries++;return{rows:[{eligible:true}]}}};
  const res=await sendSecondaryStaffText({
    contact:{id:8877,channel:"whatsapp",whatsapp_number:"60122220000"},
    messageId:71,text:"Test response",origin:"ai_reply",
  },{
    env:ENABLED,now:()=>NOW,database,
    audienceEligible:async()=>false,
    policyService:{previewSecondaryFreeformPolicy:async()=>{
      policies++;return{policyAllowed:false,code:"controlled_policy_denial"};
    }},
    billingRepo:{reserveSecondaryBillingAttempt:async()=>{
      providerCalls++;throw Error("Must not reserve");
    }},
    createTransport:async()=>{providerCalls++;throw Error("Must not send")},
  });
  assert.equal(res.code,"controlled_policy_denial");
  assert.equal(policies,1);
  assert.equal(queries,1);
  assert.equal(providerCalls,0);
  for(const origin of ["system_fallback","ai_media","followup","marketing_followup"]){
    const blocked=await sendSecondaryStaffText({
      contact:{id:8877,channel:"whatsapp",whatsapp_number:"60122220000"},
      messageId:72,text:"No other automation",origin,
    },{env:ENABLED,now:()=>NOW,database,audienceEligible:async()=>false});
    assert.notEqual(blocked.code,"controlled_policy_denial");
    assert.equal(blocked.success,false);
  }
});

test("server routes only secondary inbound text into the supervised exception",()=>{
  const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
  const section=source.slice(source.indexOf("const secondaryAiReady ="),
    source.indexOf("const secondaryAiConversation ="));
  assert.match(section,/isSecondaryAiReplyEligible\\(contact.id, \\{/);
  assert.match(section,/inboundMessageId: savedInbound.id/);
  assert.match(section,/allowReviewContinuation: !mediaType && !unsupportedType/);
  assert.match(section,/isSecondarySupervisedAiTextTestEligible\(contact.id\)/);
  assert.match(section,/!mediaType && !unsupportedType/);
  assert.match(section,/typeof incoming.text === "string"/);
});
