"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const receiver = require("../src/services/whatsappPaidProductionHistoryReceiver");
const {
  assertSenderIngressSafety,
  secondaryAdsOnlyFullAiMode,
} = require("../src/services/whatsappSenderActivationGate");

const secret = "synthetic-meta-secret-for-tests-only";
const valid = Object.freeze({
  NODE_ENV:"test",
  PR395_STAGING_MODE:"false",
  WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
  WHATSAPP_PAID_SECONDARY_QA_CAPTURE_ENABLED:"false",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_ADS_ONLY_FULL_AI_MODE_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED:"false",
  WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED:"false",
  WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
  WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
  WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
  WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true",
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
  WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-11-01T00:00:00Z",
  WHATSAPP_WABA_ID:"1593376338308612",
  WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
  WHATSAPP_PHONE_NUMBER:"+60120000000",
  WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"1852014482431209",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"1318355951360575",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
  WHATSAPP_APP_SECRET:secret,
  META_APP_SECRET:secret,
  WHATSAPP_SECONDARY_TOKEN:"synthetic-private-token",
  WHATSAPP_COEXISTENCE_ENABLED:"true",
  WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
  WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
  WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true",
  WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true",
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"false",
  WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"false",
  WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"false",
  WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED:"false",
  WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED:"false",
  WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED:"false",
  WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED:"false",
  WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
  WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
  WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
});

test("signed live receiver accepts already approved ads-only full AI without staff sending",()=>{
  assert.equal(secondaryAdsOnlyFullAiMode(valid),true);
  assert.doesNotThrow(()=>assertSenderIngressSafety(valid));
  assert.doesNotThrow(()=>receiver.assertLiveConfig(valid));
});

test("verified ads-only full AI may enable AI media and personalized follow-ups independently of staff Inbox",()=>{
  for(const overrides of [
    {WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"false"},
    {WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"false",
     WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"false"},
  ]){
    const environment={...valid,...overrides};
    assert.doesNotThrow(()=>assertSenderIngressSafety(environment));
    assert.doesNotThrow(()=>receiver.assertLiveConfig(environment));
  }
});

test("full AI receiver supports separately authorized staff text and media",()=>{
 const withStaff={...valid,WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
   WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"true"};
 assert.equal(secondaryAdsOnlyFullAiMode(withStaff),true);
 assert.doesNotThrow(()=>assertSenderIngressSafety(withStaff));
 assert.doesNotThrow(()=>receiver.assertLiveConfig(withStaff));
 assert.throws(()=>receiver.assertLiveConfig({...valid,
   WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"true"}),/Unverified/);
});

test("receiver keeps all sender, audience and signed receipt boundaries",()=>{
  const forbidden=[
    ["WHATSAPP_PAID_SECONDARY_ADS_ONLY_FULL_AI_MODE_ENABLED","false"],
    ["WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE","all"],
    ["WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT",""],
    ["WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED","true"],
    ["WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED","true"],
    ["WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED","true"],
    ["WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED","false"],
    ["WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED","false"],
    ["WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED","false"],
    ["WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED","false"],
    ["WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED","false"],
    ["WHATSAPP_SECONDARY_EXPECTED_WABA_ID","wrong"],
    ["WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID","wrong"],
    ["WHATSAPP_SECONDARY_EXPECTED_PHONE_E164","+60120000000"],
    ["META_APP_SECRET","not-the-same-secret"],
    ["WHATSAPP_SECONDARY_TOKEN",""],
    ["WHATSAPP_COEXISTENCE_ENABLED","false"],
    ["WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED","true"],
    ["PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED","true"],
    ["WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED","true"],
    ["WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED","true"],
  ];
  for(const [key,value] of forbidden){
    assert.throws(()=>receiver.assertLiveConfig({...valid,[key]:value}),
      /Unverified|disabled/,key);
  }
});

test("marketing full AI needs complete approved templates and explicit billing protections",()=>{
  const marketing={...valid,
    WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED:"true",
    WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"true",
    WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED:"true",
    WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED:"true",
  };
  assert.doesNotThrow(()=>assertSenderIngressSafety(marketing));
  assert.doesNotThrow(()=>receiver.assertLiveConfig(marketing));
  for(const key of ["WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED",
    "WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED",
    "WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED"]){
    assert.throws(()=>receiver.assertLiveConfig({...marketing,[key]:"false"}),
      /Unverified/,key);
  }
});

// Regression for RM388 3D blast: Meta accepted secondary image templates,
// but the app-default LIVE webhook rejected every signed delivery status
// because it maintained two old media-template prohibitions.
const imageMarketing = Object.freeze({
  ...valid,
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED:"true",
  WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED:"true",
  WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED:"true",
  WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED:"true",
});

test("full AI paid live receiver permits separately verified image templates without generic staff media",()=>{
  assert.equal(secondaryAdsOnlyFullAiMode(imageMarketing),true);
  assert.equal(imageMarketing.WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED,"false");
  assert.doesNotThrow(()=>assertSenderIngressSafety(imageMarketing));
  assert.doesNotThrow(()=>receiver.assertLiveConfig(imageMarketing));
  const allContacts={
    ...imageMarketing,
    WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"all_contacts",
    WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
    WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-02T00:00:00Z",
    WHATSAPP_SECONDARY_ALL_AUTOMATION_ACTIVATED_AT:"2026-11-02T01:00:00Z",
  };
  assert.doesNotThrow(()=>assertSenderIngressSafety(allContacts));
  assert.doesNotThrow(()=>receiver.assertLiveConfig(allContacts));
});

test("signed secondary status webhook reaches existing receipt handler with image-header template enabled",async()=>{
  const packet={
    object:"whatsapp_business_account",
    entry:[{
      id:valid.WHATSAPP_SECONDARY_WABA_ID,
      changes:[{field:"messages",value:{
        metadata:{phone_number_id:valid.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},
        statuses:[{id:"wamid.synthetic-rm388",status:"delivered",
          recipient_id:"60120000001",timestamp:"1794380000"}],
      }}],
    }],
  };
  const raw=Buffer.from(JSON.stringify(packet));
  const signature="sha256="+crypto.createHmac("sha256",secret).update(raw).digest("hex");
  const request={body:packet,whatsappSignedRawBody:raw,
    headers:{"x-hub-signature-256":signature}};
  const createResponse=()=>({
    statusCode:0,headersSent:false,
    sendStatus(status){this.statusCode=status;this.headersSent=true;return this;},
  });
  let received=0;
  const handle=(r,res)=>{
    received++;
    assert.deepEqual(r.body,packet);
    assert.strictEqual(r.whatsappSignedRawBody,raw);
    assert.equal(r.headers["x-hub-signature-256"],signature);
    return res.sendStatus(200);
  };
  for(let i=0;i<2;i++){
    const result=createResponse();
    await receiver.dispatch(request,result,handle,{
      env:imageMarketing,
      dispatchPrimary:()=>{throw Error("Wrong primary router");},
    });
    assert.equal(result.statusCode,200);
  }
  assert.equal(received,2); // Provider replays remain the downstream handler's responsibility.

  let rejectedToHandler=0;
  const wrongPhone=structuredClone(packet);
  wrongPhone.entry[0].changes[0].value.metadata.phone_number_id=valid.WHATSAPP_PHONE_NUMBER_ID;
  const wrongRaw=Buffer.from(JSON.stringify(wrongPhone));
  const wrongRequest={body:wrongPhone,whatsappSignedRawBody:wrongRaw,headers:{
    "x-hub-signature-256":"sha256="+crypto.createHmac("sha256",secret).update(wrongRaw).digest("hex"),
  }};
  await assert.rejects(receiver.dispatch(wrongRequest,createResponse(),()=>{
    rejectedToHandler++;}, {env:imageMarketing}),/Signed live sender identity mismatch/);
  await assert.rejects(receiver.dispatch({...request,headers:{
    "x-hub-signature-256":"sha256"+"0".repeat(64)}},createResponse(),()=>{
    rejectedToHandler++;},{env:imageMarketing}),/Invalid signed Meta raw-body proof/);
  assert.equal(rejectedToHandler,0);
});

test("image templates do not bypass staff, marketing billing, receipt or identity gates",()=>{
  for(const [key,value] of [
    ["WHATSAPP_SECONDARY_STAFF_SEND_ENABLED","false"],
    ["WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED","false"],
    ["WHATSAPP_SECONDARY_MARKETING_FOLLOWUPS_ENABLED","false"],
    ["WHATSAPP_SECONDARY_MARKETING_BILLING_APPROVED","false"],
    ["WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED","false"],
    ["WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED","false"],
    ["WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED","false"],
    ["WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED","false"],
    ["WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED","false"],
    ["WHATSAPP_SECONDARY_TOKEN",""],
    ["WHATSAPP_SECONDARY_EXPECTED_WABA_ID","0"],
    ["WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID","0"],
    ["META_APP_SECRET","invalid-secret"],
    ["WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED","true"],
  ]){
    const env={...imageMarketing,[key]:value};
    assert.throws(()=>receiver.assertLiveConfig(env),/Unverified/,key);
  }
});

test("a full AI request cannot smuggle personalized follow-up without the follow-up gate",()=>{
  assert.throws(()=>receiver.assertLiveConfig({...valid,
    WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"false",
    WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true",
  }),/Unverified/);
});
