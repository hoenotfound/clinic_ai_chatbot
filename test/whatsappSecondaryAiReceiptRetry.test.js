"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {runWhatsappOutboundRetryQueue}=require("../src/services/whatsappOutboundRetryService");

const ERROR="The previous WhatsApp message is still being confirmed. Check its delivery before another send.";
const senderEnv={
  WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
  WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"222222",
  WHATSAPP_SECONDARY_WABA_ID:"333333",
};
function row(changes={}){
  return {
    id:4,message_id:22603,contact_id:9251,recipient:"60142635859",
    origin:"ai_reply",status:"processing",processing_kind:"send_pending",
    attempts:1,lease_token:"safe-lease",message_content:"Approved AI reply",
    delivery_status:"failed",delivery_error:ERROR,last_error:ERROR,
    whatsapp_message_id:null,contact_mode:"ai",contact_channel:"whatsapp",
    contact_needs_attention:false,has_newer_customer_message:false,
    has_newer_staff_message:false,current_sender_id:2,
    current_sender_key:"neutro_secondary",current_sender_state:"active",
    current_sender_phone_number_id:"222222",
    current_sender_account_id:"333333",current_recipient:"60142635859",
    current_user_id:null,current_last_address:null,...changes,
  };
}
function setup(changes={}){
 const calls=[];
 const initial=row(changes);
 const repository={
   async recoverStaleProcessing(){return[]},
   async claimDue(){return[initial]},
   async checkSendEligibility(){calls.push("eligibility");return initial},
   async secondaryPreProviderRetrySafe(args){
     calls.push("proof");
     assert.equal(args.messageId,22603);
     assert.equal(args.originalError,ERROR);
     return true;
   },
   async markSendStarted(){calls.push("started");return{id:4}},
   async markSent(){calls.push("sent");return{id:4}},
   async reschedule(id,lease,args){calls.push(["defer",args]);return{id}},
   async markFailed(){calls.push("failed");return{id:4}},
   async markCancelled(){calls.push("cancelled");return{id:4}},
   async prepareAttention(){calls.push("prepare");return{id:4}},
   async findNextDueAt(){return null},
 };
 const messages={
   async setWhatsappMessageId(id,wamid){
     calls.push("persist_wamid");
     return{id,contact_id:9251,whatsapp_message_id:wamid,delivery_status:"pending"};
   },
   async markDeliveryUnknownIfUnconfirmed(id){
     calls.push("unknown");
     return{marked:true,accepted:false,message:{id,contact_id:9251,delivery_status:"unknown"}};
   },
   async setDeliveryStatusById(id,status){
     calls.push(status);
     return{id,contact_id:9251,delivery_status:status};
   },
 };
 const contacts={
   async getContactById(id){calls.push("contact");return{id,channel:"whatsapp",mode:"ai",
     whatsapp_number:"60142635859",whatsapp_sender_id:2,
     whatsapp_sender_key:"neutro_secondary",
     whatsapp_sender_phone_number_id:"222222",
     whatsapp_sender_account_id:"333333"}},
   async clearDeliveryAttentionIfNoFailedMessages(){calls.push("clear")},
   async setDeliveryAttention(){calls.push("attention")},
 };
 const inbound={async finalizeOutboundAttemptByAssistantMessageId(){}};
 const evidence={async recordOutcome(){calls.push("evidence")}};
 return {calls,repository,messages,contacts,inbound,evidence,senderEnv,
   isAutomationEnabled:()=>true,
   async sendMessage(){throw Error("Never use primary Meta transport")},
 };
}
test("secondary no-provider failure retries exact original AI text through secondary sender",async()=>{
 const ctx=setup();
 ctx.sendSecondaryText=async({contact,messageId,text,origin,preSendCheck})=>{
   assert.equal(contact.whatsapp_sender_key,"neutro_secondary");
   assert.equal(messageId,22603);
   assert.equal(origin,"ai_reply");
   assert.equal(text,"Approved AI reply");
   assert.equal(await preSendCheck(),true);
   assert.equal(await preSendCheck(),true);
   return{success:true,wamid:"wamid.secondary-retry"};
 };
 await runWhatsappOutboundRetryQueue(ctx);
 assert.equal(ctx.calls.filter(x=>x==="proof").length,1);
 assert.equal(ctx.calls.filter(x=>x==="started").length,1);
 assert.equal(ctx.calls.includes("persist_wamid"),true);
 assert.equal(ctx.calls.includes("sent"),true);
 assert.equal(ctx.calls.includes("clear"),true);
 assert.equal(ctx.calls.includes("attention"),false);
});
test("still-locked secondary gate is deferred without provider send or staff attention",async()=>{
 const ctx=setup();
 ctx.sendSecondaryText=async({preSendCheck})=>{
   assert.equal(await preSendCheck(),true);
   return{success:false,policyBlocked:true,wamid:null,code:"secondary_billing_previous_send_unresolved",
     error:ERROR,retryable:false};
 };
 await runWhatsappOutboundRetryQueue(ctx);
 const deferred=ctx.calls.find(x=>Array.isArray(x)&&x[0]==="defer");
 assert.ok(deferred);
 assert.equal(deferred[1].errorText,ERROR);
 assert.equal(ctx.calls.includes("failed"),false);
 assert.equal(ctx.calls.includes("attention"),false);
});
test("secondary unknown outcome is quarantined, never scheduled again",async()=>{
 const ctx=setup();
 ctx.sendSecondaryText=async({preSendCheck})=>{
   assert.equal(await preSendCheck(),true);
   return{success:false,unknown:true,ambiguous:true,cancelled:true,
     error:"Meta result uncertain"};
 };
 await runWhatsappOutboundRetryQueue(ctx);
 assert.equal(ctx.calls.includes("unknown"),true);
 assert.equal(ctx.calls.includes("failed"),true);
 assert.equal(ctx.calls.includes("attention"),true);
 assert.equal(ctx.calls.some(x=>Array.isArray(x)&&x[0]==="defer"),false);
});
test("wrong secondary sender cannot route to either transport",async()=>{
 const ctx=setup({current_sender_key:"unverified_sender"});
 ctx.sendSecondaryText=async()=>{throw Error("secondary must not send")};
 await runWhatsappOutboundRetryQueue(ctx);
 assert.equal(ctx.calls.includes("cancelled"),true);
 assert.equal(ctx.calls.includes("attention"),true);
 assert.equal(ctx.calls.includes("started"),false);
});
test("outbound primary worker remains protected and secondary enrollment is exact",()=>{
 const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
 const worker=fs.readFileSync(path.join(__dirname,
   "../src/services/whatsappOutboundRetryService.js"),"utf8");
 const repo=fs.readFileSync(path.join(__dirname,
   "../src/db/whatsappOutboundRetryRepo.js"),"utf8");
 assert.match(server,/isProvenPreProviderBlock\(sendResult\)/);
 assert.match(server,/origin === "ai_reply"/);
 assert.match(worker,/secondaryPreProviderRetrySafe/);
 assert.match(worker,/secondaryRetrySenderVerified/);
 assert.match(repo,/NOT EXISTS \(\s*SELECT 1 FROM whatsapp_sender_billing_attempts billing/);
 assert.match(repo,/NOT EXISTS \(\s*SELECT 1 FROM outbound_message_evidence evidence/);
});
