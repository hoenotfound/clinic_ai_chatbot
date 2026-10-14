"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const clinicConfig=require("../src/config/clinicConfig");
const followUpRepo=require("../src/db/followUpRepo");
const policyHoldRepo=require("../src/db/whatsappFollowUpPolicyHoldRepo");
const zeroCost=require("../src/services/whatsappZeroCostGuard");
const channelMessaging=require("../src/services/channelMessagingService");
const messagesRepo=require("../src/db/messagesRepo");
const contactsRepo=require("../src/db/contactsRepo");
const pipelineRepo=require("../src/db/pipelineRepo");
const pricingReminders=require("../src/services/pricingReminderService");
const consentPrompts=require("../src/services/whatsappConsentPromptService");
const followUp=require("../src/services/followUpService");

const candidate={
  contact_id:397,channel:"whatsapp",whatsapp_number:"60126499718",
  trigger_message_id:1544,next_follow_up_step:1,
  recent_inbound_messages:["Interested in pelvic care"],
  trigger_message_content:"We can discuss your pelvic concerns",
  treatment_interest:"Pelvic Care",
};

function setup(t,{optIn=false,preflight=null,send=null,video=false}={}) {
  const original=clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp={
    enabled:true,delayMinutes:120,triggerMode:"all",
    message:"Following up",translations:{en:"Following up",zh:"跟进一下",ms:"Susulan"},
    imageUrl:"",videoKey:video?"clients/test/follow-up.mp4":"",
    videoFilename:video?"follow-up.mp4":"",
    quietHours:{enabled:false,start:"00:00",end:"07:00"},
    activatedAt:"2026-10-13T02:47:47.647Z",
    whatsappFreeOnly:{enabled:true,allow24hAutoFollowUps:optIn,activatedAt:"2026-10-13T03:34:05Z"},
  };
  t.after(()=>{clinicConfig.automatedFollowUp=original;});
  const state={defers:[],saveCalls:0,attention:[],alertMessageIds:[],deletions:[],sendOptions:[],statuses:[]};
  t.mock.method(zeroCost,"enabled",()=>true);
  t.mock.method(zeroCost,"allow24hAutoFollowUps",()=>optIn);
  t.mock.method(zeroCost,"preflightFreeform",async()=>preflight||{allowed:true});
  t.mock.method(policyHoldRepo,"defer",async input=>{state.defers.push(input);return "future";});
  t.mock.method(policyHoldRepo,"clear",async()=>{});
  t.mock.method(followUpRepo,"markStaleClaimsUnconfirmed",async()=>[]);
  t.mock.method(followUpRepo,"getNextStaleClaimDueAt",async()=>null);
  t.mock.method(followUpRepo,"findCandidates",async()=>[candidate]);
  t.mock.method(followUpRepo,"getNextCandidateDueAt",async()=>null);
  t.mock.method(followUpRepo,"saveIfStillEligible",async()=>{
    state.saveCalls++;return {id:1550,contact_id:397,delivery_status:null};
  });
  t.mock.method(followUpRepo,"isClaimStillEligible",async()=>true);
  t.mock.method(followUpRepo,"discardUnsentClaim",async input=>{
    state.deletions.push(input);return {id:1550,contact_id:397,delivery_status:null};
  });
  t.mock.method(followUpRepo,"recordAiDecisionIfStillEligible",async()=>{
    throw new Error("temporary billing block must not permanently skip the follow-up");
  });
  t.mock.method(pricingReminders,"runPricingReminders",async()=>null);
  t.mock.method(consentPrompts,"runFinalConsentPrompts",async()=>null);
  t.mock.method(contactsRepo,"setDeliveryAttention",async (_id,reason,messageId)=>{
    state.attention.push(reason);
    state.alertMessageIds.push(messageId);
    return {};
  });
  t.mock.method(messagesRepo,"setDeliveryStatusById",async (_id,status,error)=>{
    state.statuses.push({status,error});
    return {id:1550,contact_id:397,delivery_status:status,delivery_error:error};
  });
  t.mock.method(messagesRepo,"setWhatsappMessageId",async (_id,wamid)=>
    ({id:1550,contact_id:397,delivery_status:"pending",whatsapp_message_id:wamid}));
  t.mock.method(pipelineRepo,"markContactedForContact",async()=>true);
  t.mock.method(channelMessaging,"sendText",async (_contact,_text,options)=>{
    state.sendOptions.push(options);return send||{success:true,wamid:"wamid.followup"};
  });
  t.mock.method(channelMessaging,"sendVideoByStoredKey",async (_contact,_key,_caption,_filename,options)=>{
    state.sendOptions.push(options);return send||{success:true,wamid:"wamid.video"};
  });
  return state;
}

test("unverified Strict RM0 preflight creates a temporary hold without AI/send/Telegram failure",async t=>{
  const state=setup(t,{optIn:false,preflight:{
    allowed:false,code:"zero_cost_unverified_free_entry",
  }});
  await followUp.runAutomatedFollowUps();
  assert.equal(state.saveCalls,0);
  assert.equal(state.sendOptions.length,0);
  assert.equal(state.attention.length,0);
  assert.deepEqual(state.defers,[{
    contactId:397,triggerMessageId:1544,stepIndex:1,
    reason:"zero_cost_unverified_free_entry",delaySeconds:600,
  }]);
});

test("pre-provider billing guard block discards only unsent claim, schedules retry, and suppresses false Telegram alert",async t=>{
  const state=setup(t,{optIn:true,send:{
    success:false,policyBlocked:true,policyCode:"zero_cost_previous_send_unreconciled",
    error:"Pricing proof pending",
  }});
  await followUp.runAutomatedFollowUps();
  assert.equal(state.saveCalls,1);
  assert.equal(state.sendOptions[0].autoFollowUp,true);
  assert.equal(state.deletions.length,1);
  assert.equal(state.attention.length,0);
  assert.equal(state.defers[0].reason,"zero_cost_previous_send_unreconciled");
  assert.equal(state.defers[0].delaySeconds,180);
});

test("marketing opt-out is a policy hold, never a fake Meta delivery failure",async t=>{
  const state=setup(t,{optIn:true,send:{
    success:false,policyBlocked:true,policyCode:"marketing_opted_out",
    error:"Customer declined promotions",
  }});
  await followUp.runAutomatedFollowUps();
  assert.equal(state.deletions.length,1);
  assert.equal(state.attention.length,0);
  assert.equal(state.defers[0].reason,"marketing_opted_out");
});

test("uncertain one-shot send is NOT deleted or silently retried",async t=>{
  const state=setup(t,{optIn:true,send:{
    success:false,policyBlocked:true,policyCode:"zero_cost_service_reply_already_attempted",
    error:"Previous attempt may have reached Meta",
  }});
  await followUp.runAutomatedFollowUps();
  assert.equal(state.deletions.length,0);
  assert.equal(state.defers.length,0);
  assert.equal(state.attention.length,1);
  assert.match(state.attention[0],/Delivery unconfirmed: Automated follow-up #1550/);
  assert.equal(state.statuses[0].status,"unknown");
  assert.equal(state.alertMessageIds[0],1550);
});

test("provider timeout stays UNKNOWN to protect against duplicate follow-up sends",async t=>{
  const state=setup(t,{optIn:true,send:{
    success:false,ambiguous:true,unknown:true,error:"WhatsApp request timed out",
  }});
  await followUp.runAutomatedFollowUps();
  assert.equal(state.deletions.length,0);
  assert.equal(state.defers.length,0);
  assert.equal(state.statuses[0].status,"unknown");
  assert.match(state.attention[0],/Delivery unconfirmed/);
});

test("configured treatment video passes opt-in provenance to the same provider send and records acceptance",async t=>{
  const state=setup(t,{optIn:true,video:true});
  await followUp.runAutomatedFollowUps();
  assert.equal(state.saveCalls,1);
  assert.equal(state.sendOptions.length,1);
  assert.equal(state.sendOptions[0].autoFollowUp,true);
  assert.equal(state.sendOptions[0].currentMessageId,1550);
  assert.equal(state.attention.length,0);
});
