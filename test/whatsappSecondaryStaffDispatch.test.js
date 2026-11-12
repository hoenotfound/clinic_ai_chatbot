"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { sendSecondaryStaffText, ALLOWED_RESERVATION_SQL } =
  require("../src/services/whatsappSecondaryStaffDispatch");

const env = {
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
  WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_STAGING_ENABLED:"true",
  WHATSAPP_SECONDARY_POLICY_EVALUATION_ENABLED:"true",
  WHATSAPP_SECONDARY_MANUAL_RECONCILIATION_ENABLED:"true",
  WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"333333333",
  WHATSAPP_SECONDARY_WABA_ID:"444444444",
};
const contact={
  id:54,channel:"whatsapp",whatsapp_number:"60123334444",
  whatsapp_sender_id:2, whatsapp_sender_key:"ariel",
  whatsapp_sender_phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
  whatsapp_sender_account_id:env.WHATSAPP_SECONDARY_WABA_ID,
};
const reservationId="11111111-1111-4111-8111-111111111111";
function setup({ blockAt=null, ownerMismatch=false, billingDenied=false,
  gateDenied=false, providerResult={success:true,wamid:"wamid.ariel-ok"},
  recordResult={recorded:true}, throwProvider=false }={}) {
  const calls={policy:0,db:[],send:[],mark:[],reserved:0,verify:0};
  return {calls,opts:{
    env,audienceEligible:async()=>true,database:{query:async(sql,args)=>{
      calls.db.push({sql,args});
      return {rows:gateDenied?[]:[{reservation_id:reservationId}]};
    }},
    policyService:{
      previewSecondaryFreeformPolicy:async()=>{
        calls.policy++;
        return blockAt===calls.policy ?
          {policyAllowed:false,code:"secondary_service_window_closed"} :
          {policyAllowed:true};
      },
      secondaryPolicySnapshot:async()=>({row:{sender_conversation_id:75}}),
    },
    conversationRepo:{
      senderForContact:async()=>({
        conversation_id:75, sender_key:ownerMismatch?"neutro":"ariel",
        sender_state:"active",meta_phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
        meta_account_id:env.WHATSAPP_SECONDARY_WABA_ID,
        customer_wa_id:contact.whatsapp_number,
      }),
      attachMessageContext:async()=>({message_id:120,conversation_id:75}),
    },
    billingRepo:{
      reserveSecondaryBillingAttempt:async()=>{
        calls.reserved++;
        return billingDenied?
          {reserved:false,code:"secondary_billing_previous_send_unresolved"}:
          {reserved:true,reservationId};
      },
      recordSecondaryProviderOutcome:async(input)=>{
        calls.mark.push(input);
        return recordResult;
      },
    },
    createTransport:async()=>{
      calls.verify++;
      return {sendText:async(...args)=>{
        calls.send.push(args);
        if(throwProvider)throw Error("timeout");
        return providerResult;
      }};
    },
    now:()=>new Date("2026-10-22T08:00:00Z"),
  }};
}
const data={contact,messageId:120,text:"Hello Ariel",
  replyToProviderMessageId:"wamid.original"};
const aiOnlyEnv = {
  ...env,
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"false",
  WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED:"true",
  WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED:"false",
  WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
  WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
  WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
  WHATSAPP_COEXISTENCE_ENABLED:"true",
  WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
  WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
  WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
};
test("secondary staff dispatcher is OFF by default and cannot contact Meta",async()=>{
  const {opts,calls}=setup();
  const result=await sendSecondaryStaffText(data,{
    ...opts,env:{...env,WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"false"},
  });
  assert.equal(result.code,"secondary_staff_send_disabled");
  assert.equal(calls.verify,0);
  assert.equal(calls.reserved,0);
  assert.equal(calls.send.length,0);
});

test("secondary staff quoted replies accept real Meta base64 WAMIDs",async()=>{
  const {opts,calls}=setup();
  // Meta reply IDs may contain standard base64 symbols and padding.
  const replyId="wamid.AB+CD/EF==";
  const result=await sendSecondaryStaffText({
    ...data,replyToProviderMessageId:replyId,
  },opts);
  assert.equal(result.success,true);
  assert.equal(calls.reserved,1);
  assert.equal(calls.send.length,1);
  assert.deepEqual(calls.send[0],[data.text,{replyToProviderMessageId:replyId}]);
});

test("secondary quoted reply validation still blocks malformed IDs before billing or Meta",async()=>{
  for(const replyId of ["wamid.bad?query","wamid.bad#fragment","wamid."+ "A".repeat(451)]){
    const {opts,calls}=setup();
    const result=await sendSecondaryStaffText({
      ...data,replyToProviderMessageId:replyId,
    },opts);
    assert.equal(result.code,"secondary_staff_send_invalid_input");
    assert.equal(calls.verify,0);
    assert.equal(calls.reserved,0);
    assert.equal(calls.send.length,0);
  }
});

test("verified staff text uses one sender-owned reservation and records acceptance",async()=>{
  const {opts,calls}=setup();
  const result=await sendSecondaryStaffText(data,opts);
  assert.equal(result.success,true);
  assert.equal(result.wamid,"wamid.ariel-ok");
  assert.equal(result.retryable,false);
  assert.equal(calls.policy,3);
  assert.equal(calls.verify,1);
  assert.equal(calls.reserved,1);
  assert.equal(calls.send.length,1);
  assert.deepEqual(calls.send[0],["Hello Ariel",{replyToProviderMessageId:"wamid.original"}]);
  assert.deepEqual(calls.mark,[{
    reservationId,acceptedWamid:"wamid.ariel-ok",definitivelyRejected:false,
  }]);
  assert.match(ALLOWED_RESERVATION_SQL,/whatsapp_sender_billing_alarms/);
  assert.deepEqual(calls.db[0].args.slice(0,3),[
    "ariel","333333333","444444444",
  ]);
});

test("sender or reply-window mismatch blocks before reservation and Graph API",async()=>{
  for(const input of [
    {ownerMismatch:true},
    {blockAt:1},
    {blockAt:2},
  ]){
    const {opts,calls}=setup(input);
    const result=await sendSecondaryStaffText(data,opts);
    assert.equal(result.success,false);
    assert.equal(calls.reserved,0);
    assert.equal(calls.send.length,0);
  }
});

test("a consumed sender gate denies another transport call",async()=>{
  const {opts,calls}=setup({billingDenied:true});
  const result=await sendSecondaryStaffText(data,opts);
  assert.equal(result.code,"secondary_billing_previous_send_unresolved");
  assert.equal(calls.send.length,0);
  assert.equal(calls.mark.length,0);
});

test("closed service window after reservation leaves a durable unknown hold",async()=>{
  const {opts,calls}=setup({blockAt:3});
  const result=await sendSecondaryStaffText(data,opts);
  assert.equal(result.success,false);
  assert.equal(calls.send.length,0);
  assert.deepEqual(calls.mark,[{reservationId}]);
});

test("sender-wide alarm blocks the final Graph send even after reservation",async()=>{
  const {opts,calls}=setup({gateDenied:true});
  const result=await sendSecondaryStaffText(data,opts);
  assert.equal(result.code,"secondary_staff_reservation_unverified");
  assert.equal(calls.send.length,0);
  assert.deepEqual(calls.mark,[{reservationId}]);
});

test("provider timeout cannot be automatically retried",async()=>{
  const {opts,calls}=setup({throwProvider:true});
  const result=await sendSecondaryStaffText(data,opts);
  assert.equal(result.unknown,true);
  assert.equal(result.retryable,false);
  assert.equal(calls.send.length,1);
  assert.deepEqual(calls.mark,[{reservationId}]);
});

test("accepted provider WAMID is preserved but AI outcome stays unresolved when billing evidence save fails",async()=>{
  const {opts}=setup({recordResult:{recorded:false}});
  const result=await sendSecondaryStaffText(data,opts);
  assert.equal(result.success,false);
  assert.equal(result.ambiguous,true);
  assert.equal(result.retryable,false);
  assert.equal(result.wamid,"wamid.ariel-ok");
  assert.equal(result.unknown,true);
  assert.equal(result.retryable,false);
});

test("AI text requires its own activation and does not inherit staff send permission",async()=>{
  const {opts,calls}=setup();
  const denied=await sendSecondaryStaffText({...data,origin:"ai_reply"},opts);
  assert.equal(denied.code,"secondary_staff_send_disabled");
  assert.equal(calls.send.length,0);
  const oldFlagOnly=await sendSecondaryStaffText({...data,origin:"ai_reply"},{
    ...opts,env:{...aiOnlyEnv,WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"false"},
  });
  assert.equal(oldFlagOnly.code,"secondary_staff_send_disabled");
  const activated={...opts,env:aiOnlyEnv};
  const accepted=await sendSecondaryStaffText({...data,origin:"ai_reply"},activated);
  assert.equal(accepted.success,true);
  assert.equal(calls.send.length,1);
});

test("AI text waits for signed prior receipt before its first provider call",async()=>{
  for(const origin of ["ai_reply","system_fallback"]){
    const {opts,calls}=setup();
    const waits=[];
    opts.waitForPriorSettlement=async(ms)=>waits.push(ms);
    opts.billingRepo.reserveSecondaryBillingAttempt=async()=>{
      calls.reserved++;
      return calls.reserved < 3 ?
        {reserved:false,code:"secondary_billing_previous_send_unresolved"}:
        {reserved:true,reservationId};
    };
    const result=await sendSecondaryStaffText({...data,origin},{
      ...opts,env:aiOnlyEnv,
    });
    assert.equal(result.success,true);
    assert.deepEqual(waits,[750,750]);
    assert.equal(calls.reserved,3);
    assert.equal(calls.send.length,1,"only one Meta provider call");
    assert.equal(calls.mark.length,1,"only the fresh attempt is recorded");
  }
});

test("AI pending-receipt wait cancels on staff takeover before reservation",async()=>{
  const {opts,calls}=setup({billingDenied:true});
  let checks=0;
  const result=await sendSecondaryStaffText({
    ...data,origin:"ai_reply",preSendCheck:async()=>++checks<3,
  },{
    ...opts,env:aiOnlyEnv,
    waitForPriorSettlement:async()=>{},
  });
  assert.equal(result.cancelled,true);
  assert.equal(calls.reserved,2);
  assert.equal(calls.send.length,0);
  assert.equal(calls.mark.length,0);
});

test("AI wait never bypasses unresolved prior billing or replays a send",async()=>{
  const {opts,calls}=setup({billingDenied:true});
  let waits=0;
  const result=await sendSecondaryStaffText({...data,origin:"ai_reply"},{
    ...opts,env:aiOnlyEnv,
    waitForPriorSettlement:async(ms)=>{assert.equal(ms,750);waits++;},
  });
  assert.equal(result.success,false);
  assert.equal(result.code,"secondary_billing_previous_send_unresolved");
  assert.equal(result.retryable,false);
  assert.equal(waits,8);
  assert.equal(calls.reserved,9);
  assert.equal(calls.send.length,0);
  assert.equal(calls.mark.length,0);
});

test("AI staff-takeover cancellation before reservation never calls Meta",async()=>{
  const {opts,calls}=setup();
  const result=await sendSecondaryStaffText({
    ...data,origin:"system_fallback",preSendCheck:()=>false,
  },{...opts,env:aiOnlyEnv});
  assert.equal(result.cancelled,true);
  assert.equal(calls.reserved,0);
  assert.equal(calls.send.length,0);
});

test("AI cancellation after billing reservation never reuses or frees ambiguous attempt",async()=>{
  const {opts,calls}=setup();
  let count=0;
  const result=await sendSecondaryStaffText({
    ...data,origin:"ai_reply",preSendCheck:()=>++count<2,
  },{...opts,env:aiOnlyEnv});
  assert.equal(result.ambiguous,true);
  assert.equal(calls.send.length,0);
  assert.deepEqual(calls.mark,[{reservationId}]);
});

test("AI-only transport blocks staff Inbox sends and every incomplete launch prerequisite",async()=>{
  for(const [key,value] of [
    ["WHATSAPP_SECONDARY_STAFF_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AI_SEND_ENABLED","false"],
    ["WHATSAPP_PAID_SECONDARY_LIVE_RECEIVER_ENABLED","false"],
    ["WHATSAPP_PAID_SECONDARY_HISTORY_RECEIVER_ENABLED","true"],
    ["WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED","false"],
    ["WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED","false"],
    ["WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED","false"],
    ["WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE","other"],
    ["WHATSAPP_COEXISTENCE_ENABLED","false"],
    ["WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AI_MEDIA_ENABLED","true"],
    ["WHATSAPP_SECONDARY_TEMPLATE_SEND_ENABLED","true"],
    ["WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED","true"],
  ]) {
    const {opts,calls}=setup();
    const result=await sendSecondaryStaffText({...data,origin:"ai_reply"},
      {...opts,env:{...aiOnlyEnv,[key]:value}});
    assert.equal(result.code,"secondary_staff_send_disabled",key);
    assert.equal(calls.reserved,0,key);
    assert.equal(calls.send.length,0,key);
  }
  for(const origin of ["staff","followup","ai_media"]) {
    const {opts,calls}=setup();
    const result=await sendSecondaryStaffText({...data,origin},{...opts,env:aiOnlyEnv});
    assert.equal(result.code,"secondary_staff_send_disabled",origin);
    assert.equal(calls.reserved,0);
    assert.equal(calls.send.length,0);
  }
});

test("staff Business App echo just before provider call still suppresses AI text",async()=>{
  const {opts,calls}=setup();
  let checks=0;
  const result=await sendSecondaryStaffText({
    ...data,origin:"ai_reply",preSendCheck:()=>++checks<3,
  },{...opts,env:aiOnlyEnv});
  assert.equal(checks,3);
  assert.equal(result.unknown,true);
  // Once a billing reservation exists, leave durable AI attempt ambiguous
  // rather than marking it cancelled and eligible for a new send.
  assert.notEqual(result.cancelled,true);
  assert.equal(result.retryable,false);
  assert.equal(calls.reserved,1);
  assert.equal(calls.send.length,0);
  assert.deepEqual(calls.mark,[{reservationId}]);
});

test("Meta WAMID without durable secondary billing evidence remains ambiguous to AI",async()=>{
  const {opts,calls}=setup({
    providerResult:{success:true,wamid:"wamid.provider-accepted"},
    recordResult:{recorded:false},
  });
  const result=await sendSecondaryStaffText({...data,origin:"ai_reply"},{
    ...opts,env:aiOnlyEnv,
  });
  assert.equal(result.success,false);
  assert.equal(result.wamid,"wamid.provider-accepted");
  assert.equal(result.unknown,true);
  assert.equal(result.ambiguous,true);
  assert.equal(result.retryable,false);
  assert.equal(calls.send.length,1);
  assert.equal(calls.reserved,1);
});

test("text followups reuse sender-owned transport, while media stays blocked",async()=>{
  const followupEnv={...aiOnlyEnv,WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true",
    WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true"};
  // Existing staff/AI dispatcher is the only provider entry point for
  // sender-specific text followups. No new transport is introduced.
  const textCase=setup();
  const accepted=await sendSecondaryStaffText({...data,origin:"followup"},
    {...textCase.opts,env:followupEnv});
  assert.equal(accepted.success,true);
  assert.equal(textCase.calls.send.length,1);
  const mediaCase=setup();
  const denied=await sendSecondaryStaffText({
    ...data,origin:"followup",dispatchTransport:async()=>({success:true,wamid:"wamid.unsafe"}),
  },{...mediaCase.opts,env:followupEnv});
  assert.equal(denied.success,false);
  assert.equal(mediaCase.calls.send.length,0);
  assert.equal(mediaCase.calls.reserved,0);
});

test("text-only AI never accepts a non-text provider callback",async()=>{
  for (const origin of ["ai_reply","system_fallback"]) {
    const {opts,calls}=setup();
    const result=await sendSecondaryStaffText({
      ...data,origin,dispatchTransport:async()=>({success:true,wamid:"wamid.unsafe-non-text"}),
    },{...opts,env:aiOnlyEnv});
    assert.equal(result.code,"secondary_staff_send_disabled");
    assert.equal(calls.reserved,0);
    assert.equal(calls.send.length,0);
  }
});


test("provider failure logs only safe codes while preserving unknown billing hold", async () => {
  const { opts, calls } = setup({
    providerResult: {
      success:false, wamid:null, ambiguous:true, retryable:false,
      providerFailureKind:"network_error", providerStatus:503,
      providerErrorCode:131000,
      error:"SECRET secondary-token-123 to +60123456789 message-body",
    },
    recordResult:{recorded:true,state:"unknown"},
  });
  const seen=[];
  const previous=console.warn;
  console.warn=(...args)=>seen.push(args);
  let result;
  try {
    result=await sendSecondaryStaffText({...data,origin:"ai_reply"},{...opts,env:aiOnlyEnv});
  } finally {
    console.warn=previous;
  }
  assert.equal(result.unknown,true);
  assert.equal(result.retryable,false);
  assert.equal(calls.send.length,1);
  assert.equal(calls.reserved,1);
  assert.equal(calls.mark.length,1);
  assert.equal(seen.length,1);
  assert.equal(seen[0][0],"[Secondary WhatsApp provider outcome]");
  const diagnostic=JSON.parse(seen[0][1]);
  assert.deepEqual(diagnostic,{
    outboundMessageId:120,origin:"ai_reply",kind:"network_error",
    httpStatus:503,metaErrorCode:131000,definitivelyRejected:false,ambiguous:true,
  });
  assert.doesNotMatch(JSON.stringify(seen),/SECRET|60123456789|message-body|secondary-token/);
});

test("unknown provider failure kind is never logged verbatim", async () => {
  const {opts}=setup({providerResult:{
    success:false,ambiguous:true,
    providerFailureKind:"SECRET\nINJECT",providerStatus:"not-an-http-status",
    providerErrorCode:"unexpected",error:"sensitive",
  },recordResult:{recorded:true,state:"unknown"}});
  const seen=[];
  const previous=console.warn;
  console.warn=(...args)=>seen.push(args);
  try {
    await sendSecondaryStaffText({...data,origin:"ai_reply"},{...opts,env:aiOnlyEnv});
  } finally {
    console.warn=previous;
  }
  assert.equal(seen.length,1);
  const diagnostic=JSON.parse(seen[0][1]);
  assert.equal(diagnostic.kind,"unclassified_response");
  assert.equal(diagnostic.httpStatus,null);
  assert.equal(diagnostic.metaErrorCode,null);
  assert.doesNotMatch(JSON.stringify(seen),/SECRET|INJECT|sensitive/);
});


test("ads-only full AI can send treatment text and media without granting staff Inbox access",async()=>{
 const full={
  ...aiOnlyEnv,
  WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
  WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-11-01T15:30:00Z",
  WHATSAPP_PAID_SECONDARY_ADS_ONLY_FULL_AI_MODE_ENABLED:"true",
  WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
  WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
  WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true",
  WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"false",
  WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED:"false",
 };
 const {opts,calls}=setup();
 const accepted=await sendSecondaryStaffText({...data,origin:"ai_reply"},{
  ...opts,env:full,
 });
 assert.equal(accepted.success,true);
 const staff=await sendSecondaryStaffText({...data,origin:"staff"},{
  ...opts,env:full,
 });
 assert.equal(staff.code,"secondary_staff_send_disabled");
 assert.equal(calls.reserved,1,"blocked staff send must not create another reservation");
 const noFull=await sendSecondaryStaffText({...data,origin:"ai_reply"},{
  ...opts,env:{...full,WHATSAPP_PAID_SECONDARY_ADS_ONLY_FULL_AI_MODE_ENABLED:"false"},
 });
 assert.equal(noFull.code,"secondary_staff_send_disabled");
 for(const override of [
  {WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"test_only"},
  {WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"false"},
  {WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"false"},
 ]){
  const blocked=await sendSecondaryStaffText({...data,origin:"ai_reply"},{
   ...opts,env:{...full,...override},
  });
  assert.equal(blocked.code,"secondary_staff_send_disabled",JSON.stringify(override));
 }
});

test("full AI retains AI replies with verified staff text and image dispatch",async()=>{
 const withStaff={
   ...aiOnlyEnv,
   WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
   WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-11-01T15:30:00Z",
   WHATSAPP_PAID_SECONDARY_ADS_ONLY_FULL_AI_MODE_ENABLED:"true",
   WHATSAPP_PAID_SECONDARY_PARITY_MODE_ENABLED:"false",
   WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
   WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
   WHATSAPP_SECONDARY_FOLLOWUPS_ENABLED:"true",
   WHATSAPP_SECONDARY_STAFF_SEND_ENABLED:"true",
   WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"true",
 };
 const {opts,calls}=setup();
 const staff=await sendSecondaryStaffText({...data,origin:"staff"},{...opts,env:withStaff});
 assert.equal(staff.success,true);
 const image=await sendSecondaryStaffText({...data,origin:"staff",
   dispatchTransport:async()=>({success:true,wamid:"wamid.verified-media"}),
 },{...opts,env:withStaff});
 assert.equal(image.success,true);
 const ai=await sendSecondaryStaffText({...data,origin:"ai_reply"},{...opts,env:withStaff});
 assert.equal(ai.success,true);
 assert.equal(calls.reserved,3);
 assert.equal(calls.send.length,2,"media goes through distinct sender-owned transport");
 const blocked=await sendSecondaryStaffText({...data,origin:"staff",
   dispatchTransport:async()=>{throw Error("blocked media cannot reach provider");},
 },{...opts,env:{...withStaff,WHATSAPP_SECONDARY_STAFF_MEDIA_ENABLED:"false"}});
 assert.equal(blocked.code,"secondary_staff_send_disabled");
 assert.equal(calls.reserved,3);
});


test("consecutive secondary staff pictures wait for prior receipt before sending the next",async()=>{
  const {opts,calls}=setup();
  let reservations=0, providerCalls=0;
  const result=await sendSecondaryStaffText({
    ...data,text:"[staff media]",origin:"staff",
    dispatchTransport:async()=>{providerCalls++;return {success:true,wamid:"wamid.second-picture"};},
    preSendCheck:async()=>true,
  },{
    ...opts,waitForPriorSettlement:async()=>{},
    billingRepo:{
      ...opts.billingRepo,
      reserveSecondaryBillingAttempt:async()=>{
        reservations++;
        return reservations < 3
          ? {reserved:false,code:"secondary_billing_previous_send_unresolved"}
          : {reserved:true,reservationId};
      },
    },
  });
  assert.equal(reservations,3);
  assert.equal(providerCalls,1);
  assert.equal(result.success,true);
  assert.equal(result.wamid,"wamid.second-picture");
  assert.equal(calls.mark.length,1);
});

test("unresolved previous secondary picture never bypasses billing gate or reaches Meta",async()=>{
  const {opts,calls}=setup({billingDenied:true});
  let providerCalls=0,waits=0;
  const result=await sendSecondaryStaffText({
    ...data,text:"[staff media]",origin:"staff",
    dispatchTransport:async()=>{providerCalls++;return {success:true,wamid:"wamid.should-not-send"};},
    preSendCheck:async()=>true,
  },{
    ...opts,waitForPriorSettlement:async()=>{waits++;},
  });
  assert.equal(result.code,"secondary_billing_previous_send_unresolved");
  assert.match(result.error,/previous WhatsApp message is still being confirmed/i);
  assert.equal(waits,4);
  assert.equal(providerCalls,0);
  assert.equal(calls.reserved,5);
  assert.equal(calls.mark.length,0);
});

test("gated 131060 treatment menu reaches secondary interactive transport, not primary or generic AI",async()=>{
 const {recoveryTreatmentButtons,build131060RecoveryReply}=
   require("../src/services/whatsapp131060Recovery");
 const menu=recoveryTreatmentButtons();
 const text=build131060RecoveryReply({unsupportedType:"unsupported"});
 const withRecovery={
   ...aiOnlyEnv,
   WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
   WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
   WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:"2026-11-10T09:00:00Z",
   WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"true",
   WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:"2026-11-10T09:00:00Z",
 };
 function context(extra={}){
   const {opts,calls}=setup();
   const buttonCalls=[];
   const deps={
     ...opts,env:{...withRecovery,...extra},
     replyAudienceEligible:async()=>true,
     conversationRepo:{
       ...opts.conversationRepo,
       senderForContact:async()=>({
         conversation_id:75,sender_key:"neutro_secondary",sender_state:"active",
         meta_phone_number_id:withRecovery.WHATSAPP_SECONDARY_PHONE_NUMBER_ID,
         meta_account_id:withRecovery.WHATSAPP_SECONDARY_WABA_ID,
         customer_wa_id:contact.whatsapp_number,
       }),
     },
     createTransport:async()=>{
       calls.verify++;
       return{sendInteractiveButtons:async(body,buttons)=>{
         buttonCalls.push({body,buttons});
         return{success:true,wamid:"wamid.menu-accepted"};
       }};
     },
   };
   return{deps,calls,buttonCalls};
 }
 const user={...contact,whatsapp_sender_key:"neutro_secondary"};
 const input={contact:user,messageId:120,text,origin:"system_fallback",
   interactiveButtons:menu,preSendCheck:()=>true};
 const ok=context();
 const accepted=await sendSecondaryStaffText(input,ok.deps);
 assert.equal(accepted.success,true);
 assert.equal(ok.calls.reserved,1);
 assert.equal(ok.buttonCalls.length,1);
 assert.deepEqual(ok.buttonCalls[0],{body:text,buttons:menu});
 assert.deepEqual(ok.calls.mark,[{
   reservationId,acceptedWamid:"wamid.menu-accepted",definitivelyRejected:false,
 }]);
 for(const invalid of [
   {...input,origin:"ai_reply"},
   {...input,interactiveButtons:[...menu.slice(0,2),{id:"random",title:"脉冲波"}]},
   {...input,text:"Unauthorized menu"},
 ]) {
   const c=context();
   const result=await sendSecondaryStaffText(invalid,c.deps);
   assert.equal(result.code,"secondary_131060_recovery_menu_invalid");
   assert.equal(c.calls.reserved,0);
   assert.equal(c.buttonCalls.length,0);
 }
 const off=context({WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"false"});
 const noSend=await sendSecondaryStaffText(input,off.deps);
 assert.equal(noSend.code,"secondary_131060_recovery_menu_invalid");
 assert.equal(off.buttonCalls.length,0);
 const staffEcho=context();
 const stopped=await sendSecondaryStaffText({...input,preSendCheck:()=>false},staffEcho.deps);
 assert.equal(stopped.cancelled,true);
 assert.equal(staffEcho.buttonCalls.length,0);
});


test("secondary sender refuses a changed recipient after billing reservation, without Meta send",async()=>{
  const {opts,calls}=setup();
  opts.billingRepo.reserveSecondaryBillingAttempt=async()=>({
    reserved:true,reservationId,recipientAddress:"MY.SignedOld",
  });
  opts.createTransport=async()=>({
    recipientAddress:"MY.SignedNew",
    sendText:async()=>{calls.send.push("unexpected");throw Error("must not reach Meta");},
  });
  const result=await sendSecondaryStaffText(data,opts);
  assert.equal(result.success,false);
  assert.equal(result.code,"secondary_recipient_changed_before_provider");
  assert.equal(calls.send.length,0);
  assert.equal(calls.mark.length,1);
  assert.equal(calls.mark[0].definitivelyRejected,true);
});
