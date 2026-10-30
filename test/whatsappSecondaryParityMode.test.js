"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {assertSenderIngressSafety}=require("../src/services/whatsappSenderActivationGate");
const receiver=require("../src/services/whatsappPaidProductionHistoryReceiver");
const {sendSecondaryStaffText}=require("../src/services/whatsappSecondaryStaffDispatch");
const {enabled:mediaEnabled}=require("../src/services/whatsappSecondaryAiMediaQueue");
const {enabled:followupsEnabled}=require("../src/services/whatsappSecondaryFollowUpService");

const secret="synthetic-not-a-secret-sufficiently-long";
const base=Object.freeze({
 PR395_STAGING_MODE:"false",
 WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
 WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED:"true",
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
 WHATSAPP_APP_SECRET:secret,META_APP_SECRET:secret,
 WHATSAPP_SECONDARY_TOKEN:"synthetic-secondary-token",
 WHATSAPP_COEXISTENCE_ENABLED:"true",
 WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
 WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
 WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
 WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
 WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
 WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
 WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
 WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
 WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
 WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
 WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
 WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
 WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"false",
 WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"false",
 WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"false",
 WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED:"false",
 WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"false",
 WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED:"false",
});
const contact={id:21,channel:"whatsapp",mode:"ai",whatsapp_number:"60123334444",
 whatsapp_sender_id:4,whatsapp_sender_key:"neutro_secondary",
 whatsapp_sender_phone_number_id:base.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
 whatsapp_sender_account_id:base.WHATSAPP_SECONDARY_WABA_ID};
const reservationId="11111111-1111-4111-8111-111111111111";
function fake(){
 const calls={sends:[],reservations:[],outcomes:[],policy:0,db:[]};
 const opts={
  env:base,
  database:{query:async(sql,args)=>{calls.db.push({sql,args});return{rows:[{reservation_id:reservationId}]}}},
  policyService:{
   previewSecondaryFreeformPolicy:async()=>{calls.policy++;return{policyAllowed:true}},
   secondaryPolicySnapshot:async()=>({row:{sender_conversation_id:11}}),
  },
  conversationRepo:{
   senderForContact:async()=>({conversation_id:11,sender_key:"neutro_secondary",
    sender_state:"active",meta_phone_number_id:base.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    meta_account_id:base.WHATSAPP_SECONDARY_WABA_ID,customer_wa_id:contact.whatsapp_number}),
   attachMessageContext:async()=>({conversation_id:11}),
  },
  billingRepo:{
   reserveSecondaryBillingAttempt:async x=>{calls.reservations.push(x);return{reserved:true,reservationId}},
   recordSecondaryProviderOutcome:async x=>{calls.outcomes.push(x);return{recorded:true}},
  },
  createTransport:async()=>({
   sendText:async()=>{calls.sends.push("text");return{success:true,wamid:"wamid.synthetic"}} ,
   sendImageByUrl:async()=>{calls.sends.push("image");return{success:true,wamid:"wamid.synthetic"}} ,
  }),
 };
 return {opts,calls};
}
const send=(origin,extras={},env=base)=>{
 const f=fake();
 return sendSecondaryStaffText({contact,messageId:42,text:"Verified Neutro message",origin,...extras},{...f.opts,env})
  .then(result=>({result,calls:f.calls}));
};

test("parity mode remains OFF unless every critical signed/billing gate is verified",()=>{
 assert.doesNotThrow(()=>receiver.assertLiveConfig(base));
 assert.doesNotThrow(()=>assertSenderIngressSafety(base));
 for(const [name,value] of [
  ["WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED","false"],
  ["WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED","false"],
  ["WHATSAPP_PAID_SECONDARY_STAFF_TEXT_MODE_ENABLED","true"],
  ["WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED","true"],
  ["WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED","false"],
  ["WHATSAPP_SECONDARY_AI_SEND_ENABLED","false"],
  ["WHATSAPP_SECONDARY_STAFF_SEND_ENABLED","false"],
  ["WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED","false"],
  ["WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED","false"],
  ["WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED","false"],
  ["WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED","false"],
  ["WHATSAPP_SECONDARY_TOKEN",""],
  ["WHATSAPP_SECONDARY_EXPECTED_WABA_ID","wrong"],
  ["WHATSAPP_CAPTURE_TO_INBOX_HANDOFF_ENABLED","true"],
  ["PR395_COEXISTENCE_SYNC_DISPATCH_ENABLED","true"],
  ["WHATSAPP_SECONDARY_AUTO_RECONCILE_BILLABLE_ENABLED","true"],
 ]) {
  const env={...base,[name]:value};
  if(name==="WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED"){
   // Legacy AI-only refuses staff and auto-reconcile.
   assert.throws(()=>receiver.assertLiveConfig(env),/Unverified/);
  }else assert.throws(()=>receiver.assertLiveConfig(env),/Unverified|disabled/,name);
 }
 assert.equal(mediaEnabled(base),false);
 assert.equal(followupsEnabled(base),false);
});
test("safe approved sender media/template and text followups may opt in separately",()=>{
 const env={...base,WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"true",
  WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
  WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_TEMPLATE_MEDIA_ENABLED:"true",
  WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true"};
 assert.doesNotThrow(()=>receiver.assertLiveConfig(env));
 assert.doesNotThrow(()=>assertSenderIngressSafety(env));
 assert.equal(mediaEnabled(env),true);
 assert.equal(followupsEnabled(env),true);
 assert.throws(()=>receiver.assertLiveConfig({...env,
  WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED:"false"}),/Unverified/);
});
test("same persisted conversation can send either AI or staff text through one billing guard",async()=>{
 const ai=await send("ai_reply");
 const staff=await send("staff");
 for(const value of [ai,staff]){
  assert.equal(value.result.success,true);
  assert.deepEqual(value.calls.sends,["text"]);
  assert.equal(value.calls.reservations.length,1);
  assert.equal(value.calls.outcomes.length,1);
  assert.equal(value.calls.db[0].args[0],base.WHATSAPP_SECONDARY_SENDER_KEY);
 }
});
test("separate AI-media callback is blocked until its own opt-in",async()=>{
 let attempted=0;
 const callback=async transport=>{attempted++;return transport.sendImageByUrl("https://example.test/x.jpg","ok")};
 const blocked=await send("ai_media",{dispatchTransport:callback});
 assert.equal(blocked.result.code,"secondary_staff_send_disabled");
 assert.equal(attempted,0);
 const allowed=await send("ai_media",{dispatchTransport:callback},{
  ...base,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true"
 });
 assert.equal(allowed.result.success,true);
 assert.deepEqual(allowed.calls.sends,["image"]);
 assert.equal(attempted,1);
});
test("staff media and templates must be opted in independently; AI text cannot use callbacks",async()=>{
 const callback=async transport=>transport.sendImageByUrl("https://example.test/x.jpg","ok");
 for(const origin of ["ai_reply","system_fallback"]){
  const bad=await send(origin,{dispatchTransport:callback},{
   ...base,WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true"});
  assert.equal(bad.result.code,"secondary_staff_send_disabled");
 }
 const blocked=await send("staff",{dispatchTransport:callback});
 assert.equal(blocked.result.code,"secondary_staff_send_disabled");
 const allowed=await send("staff",{dispatchTransport:callback},{
  ...base,WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"true"
 });
 assert.equal(allowed.result.success,true);
 const badTemplate=await send("staff",{dispatchTransport:callback,
  templateRequest:{billingConfirmed:true,name:"sample",languageCode:"en_US"}});
 assert.equal(badTemplate.result.code,"secondary_staff_send_disabled");
});
test("wrong sender, missing consent and unknown Meta outcomes still never bypass guard",async()=>{
 const f=fake();
 const mismatched={...contact,whatsapp_sender_key:"neutro"};
 const denied=await sendSecondaryStaffText({contact:mismatched,messageId:42,text:"x",origin:"ai_reply"},
  {...f.opts,conversationRepo:{...f.opts.conversationRepo,senderForContact:async()=>({
    conversation_id:11,sender_key:"neutro",sender_state:"active",
    meta_phone_number_id:base.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
    meta_account_id:base.WHATSAPP_SECONDARY_WABA_ID,customer_wa_id:contact.whatsapp_number
  })}});
 assert.equal(denied.success,false);
 assert.equal(f.calls.sends.length,0);
 const failed=fake();
 failed.opts.policyService.previewSecondaryFreeformPolicy=async()=>({policyAllowed:false,
  code:"secondary_missing_opt_in"});
 const deniedConsent=await sendSecondaryStaffText({
  contact,messageId:42,text:"x",origin:"staff"},failed.opts);
 assert.equal(deniedConsent.success,false);
 assert.equal(failed.calls.reservations.length,0);
});
