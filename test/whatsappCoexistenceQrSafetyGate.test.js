"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const gate=require("../src/services/whatsappCoexistenceQrSafetyGate");
function ready(){
  const before=Object.fromEntries(gate.REQUIRED_BEFORE_QR.map(k=>[k,true]));
  before.confirmedFields=[...gate.REQUIRED_FIELDS];
  const env={
    WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
    WHATSAPP_PAID_DEFAULT_SECONDARY_PHONE_E164:"+60129998888",
    WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+601130535053",
    WHATSAPP_WABA_ID:"1593376338308612",
    WHATSAPP_PHONE_NUMBER_ID:"1408739622311791"
  };
  return{before,env};
}
test("CI green and field subscriptions alone never authorize a QR",()=>{
  const {env}=ready();
  const report=gate.inspectQrReadiness({env,before:{confirmedFields:[...gate.REQUIRED_FIELDS]}});
  assert.equal(report.qr.readyForOwnerApproval,false);
  assert.ok(report.qr.missing.includes("productionV079RollbackRehearsed"));
  assert.ok(report.qr.missing.includes("signedDefaultCallbackLiveVerified"));
  assert.equal(report.immutableSafety.automaticQr,false);
});
test("pre-QR only passes with explicit independently observed evidence",()=>{
  const {env,before}=ready();
  const report=gate.inspectQrReadiness({env,before});
  assert.equal(report.qr.readyForOwnerApproval,true);
  assert.equal(report.sync.readyForManualAuthorization,false);
  assert.equal(report.immutableSafety.automaticSyncPost,false);
});
test("post-QR one-time sync enforces exact identity, consent and 24h window",()=>{
  const {env,before}=ready();
  const after=Object.fromEntries(gate.REQUIRED_AFTER_QR.map(k=>[k,true]));
  Object.assign(after,{
    wabaId:"889900",phoneNumberId:"112233",
    onboardingCompletedAt:"2026-10-28T01:00:00Z",
    historyConsent:true,requestHistory:true
  });
  const ok=gate.inspectQrReadiness({
    env,before,after,now:new Date("2026-10-28T02:00:00Z")});
  assert.equal(ok.sync.readyForManualAuthorization,true);
  assert.equal(ok.immutableSafety.automaticSyncPost,false);
  const tooLate=gate.inspectQrReadiness({
    env,before,after,now:new Date("2026-10-29T02:00:00Z")});
  assert.equal(tooLate.sync.readyForManualAuthorization,false);
  assert.ok(tooLate.sync.missing.includes("within_24_hour_one_time_sync_window"));
  after.phoneNumberId=env.WHATSAPP_PHONE_NUMBER_ID;
  const primary=gate.inspectQrReadiness({
    env,before,after,now:new Date("2026-10-28T02:00:00Z")});
  assert.ok(primary.sync.missing.includes("separate_verified_meta_identity"));
});
test("secondary outbound flags and unverified fields block QR",()=>{
  const {env,before}=ready();
  assert.equal(gate.inspectQrReadiness({
    env:{...env,WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true"},before
  }).qr.readyForOwnerApproval,false);
  assert.equal(gate.inspectQrReadiness({
    env,before:{...before,confirmedFields:["messages"]}
  }).qr.readyForOwnerApproval,false);
});
