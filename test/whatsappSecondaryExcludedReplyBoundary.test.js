"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const server = fs.readFileSync(path.join(__dirname, "../src/server.js"), "utf8");

function realServerFunction(startMarker, endMarker, functionName, context) {
  const start = server.indexOf(startMarker);
  const end = server.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, "real server function must be present");
  return vm.runInNewContext(
    server.slice(start, end) + "\n" + functionName + ";",
    context,
    {filename:"src/server.js"}
  );
}

async function excludedIncoming({scopedIngress = true} = {}) {
  const calls = {audience:0, testException:0, model:0, outbound:0,
    lead:0, attention:0, errors:[]};
  const incoming = realServerFunction(
    "async function processIncomingMessage(", "// Runtime secret checks",
    "processIncomingMessage", {
      process:{env:{
        WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:scopedIngress?"true":"false",
        WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
        WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
        WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
        WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
      }},
      console:{log:()=>{},warn:()=>{},error:(...args)=>calls.errors.push(args.join(" "))},
      clinicConfig:{},
      getOperationalLabels:()=>({customerLabel:"customer",customerSingular:"customer"}),
      secondaryUsesPrimaryClinicContent:()=>true,
      isSecondaryAdsOnlyEligible:async()=>{calls.audience++;return false;},
      isSecondarySupervisedAiTextTestEligible:async()=>{
        calls.testException++;return false;
      },
      aiReplyCancellation:{
        keyForWhatsAppNumber:()=> "neutro_secondary:example",
        snapshot:()=>0,
        safeToSend:()=>true,
      },
      reviewLeadTemperatureForMessage:async()=>{calls.lead++;throw Error("should not score");},
      sendTrackedText:async()=>{calls.outbound++;throw Error("should not save reply");},
      contactsRepo:{setAiReviewAttention:async()=>{calls.attention++;}},
      ai:{getReply:async()=>{calls.model++;throw Error("should not generate");},
        isRecoverableAiReplyFailure:()=>false},
    }
  );
  const result = await incoming({
    incoming:{id:"wamid.known-primary-new-secondary-ad",from:"601125187705",
      channel:"whatsapp",mediaType:null,unsupportedType:null,
      text:"Hi, I came from a 3D facial ad"},
    contact:{id:8885,whatsapp_number:"601125187705",channel:"whatsapp",
      mode:"ai",whatsapp_sender_id:2,whatsapp_sender_key:"neutro_secondary"},
    savedInbound:{id:16381,contact_id:8885,role:"user",content:"3D facial"},
    processingJobId:1164,
    wasFirstMessage:true,
  });
  assert.equal(result.wasFirstMessage,true);
  return calls;
}

test("known-primary secondary ad message stays manual before any AI or reply draft",async()=>{
  const calls=await excludedIncoming();
  assert.equal(calls.audience,1,"consult the persisted first-ad/earlier-primary audience rule");
  assert.equal(calls.testException,1,"only the fixed supervised test contact can bypass");
  assert.equal(calls.model,0);
  assert.equal(calls.outbound,0);
  assert.equal(calls.lead,0);
  assert.equal(calls.attention,0,"routine manual message must not create AI alerts");
  assert.deepEqual(calls.errors,[]);
});

test("secondary ad restriction cannot be bypassed by disabling sender-scoped ingress",async()=>{
  const calls=await excludedIncoming({scopedIngress:false});
  assert.equal(calls.audience,1);
  assert.equal(calls.model,0);
  assert.equal(calls.outbound,0);
  assert.equal(calls.attention,0);
  assert.deepEqual(calls.errors,[]);
});

async function trackedSend({eligible=false, origin="ai_reply", durable=true}={}) {
  const calls={queries:0,supervised:0,reservations:0,appended:0,dispatched:0,
    attention:0,finalized:0};
  const contact={id:8885,whatsapp_number:"601125187705",channel:"whatsapp",
    whatsapp_sender_id:2,whatsapp_sender_key:"neutro_secondary",
    whatsapp_sender_phone_number_id:"1318355951360575",
    whatsapp_sender_account_id:"1852014482431209"};
  const sendTrackedText=realServerFunction(
    "async function sendTrackedText(", "function unwrapIncoming(", "sendTrackedText",{
      process:{env:{WHATSAPP_PRIMARY_SENDER_KEY:"neutro"}},
      isSecondaryAdsOnlyEligible:async()=>{calls.queries++;return eligible;},
      isSecondarySupervisedAiTextTestEligible:async()=>{calls.supervised++;return false;},
      inboundProcessingRepo:{
        reserveOutboundAttempt:async()=>{calls.reservations++;return {
          message:{id:90011,contact_id:contact.id},alreadyStarted:false
        };},
        finalizeOutboundAttempt:async()=>{calls.finalized++;},
      },
      conversationStore:{
        appendMessageForContact:async()=>{calls.appended++;return {
          id:90011,contact_id:contact.id
        };},
      },
      messagesRepo:{socialProviderAliasRecorder:()=>null},
      realtimeEvents:{publish:()=>{}},
      scopeForPersistedContact:()=>({channel:"whatsapp"}),
      sendSecondaryStaffText:async()=>{calls.dispatched++;return {
        success:true,wamid:"wamid.verified-secondary"
      };},
      channelMessaging:{
        rejectedError:()=> "simulated provider rejection",
        sendText:async()=>{throw Error("wrong sender")},
      },
      persistSendOutcome:async(message)=>message,
      providerMessageId:()=> "wamid.verified-secondary",
      recordReadinessSendEvidence:()=>{},
    });
  const result=await sendTrackedText(contact,"AI text",origin,
    durable?{processingJobId:1164}:{});
  return {calls,result};
}

test("excluded secondary AI and system fallback never reserve a message or create delivery errors",async()=>{
  for(const origin of ["ai_reply","system_fallback"]){
    for(const durable of [true,false]){
      const {calls,result}=await trackedSend({eligible:false,origin,durable});
      assert.equal(result.finalMessage,null);
      assert.equal(result.sendResult.cancelled,true);
      assert.equal(result.sendResult.code,"secondary_ads_only_contact_ineligible");
      assert.equal(calls.reservations,0);
      assert.equal(calls.appended,0);
      assert.equal(calls.dispatched,0);
      assert.equal(calls.attention,0);
      assert.equal(calls.finalized,0);
    }
  }
});

test("eligible secondary ad still reaches its original guarded delivery path",async()=>{
  const {calls,result}=await trackedSend({eligible:true,durable:true});
  assert.equal(calls.queries,1);
  assert.equal(calls.supervised,0);
  assert.equal(calls.reservations,1);
  assert.equal(calls.dispatched,1);
  assert.equal(calls.finalized,1);
  assert.equal(result.sendResult.success,true);
});
