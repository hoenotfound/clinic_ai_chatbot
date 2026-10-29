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
    env,database:{query:async(sql,args)=>{
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

test("accepted provider WAMID is preserved even when billing evidence save fails",async()=>{
  const {opts}=setup({recordResult:{recorded:false}});
  const result=await sendSecondaryStaffText(data,opts);
  assert.equal(result.success,true);
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
