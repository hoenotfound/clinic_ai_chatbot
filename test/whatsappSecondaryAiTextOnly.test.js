"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const receiver=require("../src/services/whatsappPaidProductionHistoryReceiver");
const {assertSenderIngressSafety}=require("../src/services/whatsappSenderActivationGate");

const secret="synthetic-hmac-secret-of-at-least-24-characters";
const LIVE=Object.freeze({
  PR395_STAGING_MODE:"false",
  WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED:"false",
  WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
  WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
  WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true",
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_WABA_ID:"1593376338308612",
  WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
  WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"1852014482431209",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
  WHATSAPP_APP_SECRET:secret,
  META_APP_SECRET:secret,
  WHATSAPP_SECONDARY_TOKEN:"synthetic-do-not-use",
  WHATSAPP_COEXISTENCE_ENABLED:"true",
  WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
  WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
  WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"false",
  WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"false",
  WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"false",
  WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"false",
  WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"false",
});
const entry=(id,field,phone)=>({
  id,changes:[{field,value:{metadata:{phone_number_id:phone},
    messages:[{id:"wamid.synthetic-new-inbound",from:"60123334444",type:"text",
      text:{body:"请问骨盆调理怎样预约？"}}]}}],
});
const packet=(...entries)=>({object:"whatsapp_business_account",entry:entries});
function request(body){
  const signedRaw=Buffer.from(JSON.stringify(body));
  const signature="sha256="+crypto.createHmac("sha256",secret)
    .update(signedRaw).digest("hex");
  // Mimic Node HTTP IncomingMessage's non-own `headers` accessor.
  const req=Object.create(Object.defineProperty({},"headers",{
    enumerable:false,get:()=>({"x-hub-signature-256":signature}),
  }));
  req.body=body;req.whatsappSignedRawBody=signedRaw;
  return req;
}
function res(){
  return {statusCode:null,sendStatus(code){this.statusCode=code;return this;}};
}

test("AI-only signed live receiver and operational gate accept exact isolated identity",()=>{
  assert.equal(receiver.assertLiveConfig(LIVE).secondaryPhone,LIVE.WHATSAPP_SECONDARY_PHONE_NUMBER_ID);
  assert.doesNotThrow(()=>assertSenderIngressSafety(LIVE));
});
test("AI-only refuses incomplete dependencies and ALL competing sender operation modes",()=>{
  const forbidden=[
    ["WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED","false"],
    ["WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED","true"],
    ["WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED","false"],
    ["WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AI_SEND_ENABLED","false"],
    ["WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED","false"],
    ["WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED","false"],
    ["WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED","false"],
    ["WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED","false"],
    ["WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED","false"],
    ["WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED","false"],
    ["WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED","false"],
    ["WHATSAPP_SECONDARY_TOKEN",""],
    ["WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE","different-clinic"],
    ["WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED","false"],
    ["WHATSAPP_COEXISTENCE_ENABLED","false"],
    ["WHATSAPP_SECONDARY_STAFF_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AI_MEDIA_ENABLED","true"],
    ["WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED","true"],
    ["WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED","true"],
    ["WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED","true"],
    ["PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED","true"],
    ["WHATSAPP_SECONDARY_PHONE_NUMBER_ID",LIVE.WHATSAPP_PHONE_NUMBER_ID],
    ["WHATSAPP_SECONDARY_WABA_ID",LIVE.WHATSAPP_WABA_ID],
    ["WHATSAPP_SECONDARY_EXPECTED_PHONE_E164","+60120000000"],
    ["WHATSAPP_APP_SECRET","not-the-app-secret"],
  ];
  for(const [key,value] of forbidden){
    assert.throws(()=>receiver.assertLiveConfig({...LIVE,[key]:value}),
      /Unverified|disabled/,key+" must not activate live sender");
  }
});
test("standalone AI flag never upgrades passive Inbox or guarded staff cutover",()=>{
  assert.throws(()=>receiver.assertLiveConfig({
    ...LIVE,
    WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"false",
    WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  }),/Unverified/);
  assert.throws(()=>receiver.assertLiveConfig({
    ...LIVE,
    WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
    WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED:"true",
    WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
  }),/Unverified/);
});
test("signed real-time inbound and staff echo can share exact primary callback without losing HMAC",async()=>{
  const body=packet(
    entry(LIVE.WHATSAPP_WABA_ID,"messages",LIVE.WHATSAPP_PHONE_NUMBER_ID),
    entry(LIVE.WHATSAPP_SECONDARY_WABA_ID,"messages",LIVE.WHATSAPP_SECONDARY_PHONE_NUMBER_ID),
    entry(LIVE.WHATSAPP_SECONDARY_WABA_ID,"smb_message_echoes",LIVE.WHATSAPP_SECONDARY_PHONE_NUMBER_ID),
  );
  const original=request(body),response=res();
  let routed=0;
  await receiver.dispatch(original,response,(forwarded,r)=>{
    routed++;
    assert.equal(forwarded.headers["x-hub-signature-256"],original.headers["x-hub-signature-256"]);
    assert.equal(forwarded.whatsappSignedRawBody,original.whatsappSignedRawBody);
    assert.equal(forwarded.body.entry.length,3);
    assert.equal(original.body,body);
    return r.sendStatus(200);
  },{env:LIVE,dispatchPrimary:()=>{throw Error("verified live must not fall back");},
    stageHistory:()=>{throw Error("live reception must not import history");}});
  assert.equal(response.statusCode,200);
  assert.equal(routed,1);
});
test("old imported history never enters AI through live-only route",async()=>{
  const old=packet(entry(LIVE.WHATSAPP_SECONDARY_WABA_ID,"history",
    LIVE.WHATSAPP_SECONDARY_PHONE_NUMBER_ID));
  let sent=0;
  await assert.rejects(receiver.dispatch(request(old),res(),()=>{sent++;},{
    env:LIVE,stageHistory:()=>{sent++;throw Error("Never import in AI mode");},
    dispatchPrimary:()=>{sent++;throw Error("Never fall through");},
  }),/Secondary history receiver not approved/);
  assert.equal(sent,0);
});
