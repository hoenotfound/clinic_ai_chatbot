"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const source=fs.readFileSync(path.join(__dirname,"../src/services/whatsappCoexistenceService.js"),"utf8");

test("duplicate provider echo retries failed reminder hold without inventing an AI turn",async()=>{
  let attempts=0;
  const seen=[];
  const stubs={
    "../db/contactsRepo":{clearDeliveryAttentionIfNoFailedMessages:async()=>{}},
    "../db/pipelineRepo":{ensureLeadForContact:async()=>{},markContactedForContact:async()=>{}},
    "../utils/realtimeEvents":{publish:()=>{}},
    "./staffBookingConfirmationService":{
      isProactiveAppointmentReminder:()=>true,
      recordStaffConfirmedBooking:async(contactId,text,options)=>{
        seen.push({contactId,text,options});
        if(++attempts===1)throw Error("temporary database outage");
      },
    },
  };
  const sandbox={
    module:{exports:{}},exports:{},
    require:(name)=>stubs[name]||{},
    process:{env:{}},console:{error:()=>{},warn:()=>{},info:()=>{}},
    setTimeout,
  };
  vm.runInNewContext(source,sandbox,{filename:"whatsappCoexistenceService.js"});
  const finalize=sandbox.module.exports.finalizeBusinessAppEcho;
  const echo={contact:{id:1005},message:{
    id:17279,content:"Morning dear remind appointment tmr 11.30am",
    whatsapp_message_id:"wamid.17279",sent_by_username:"WhatsApp Business App",
    is_forwarded:false,
  },isNew:false};
  await assert.rejects(finalize(echo),/temporary database outage/);
  await finalize(echo);
  assert.equal(attempts,2);
  for(const item of seen){
    assert.equal(item.contactId,1005);
    assert.equal(item.options.providerAccepted,true);
    assert.equal(item.options.messageId,17279);
  }
});

test("webhook reports a failed durable-finalization so Meta can replay an unchanged staff echo",()=>{
  const app=fs.readFileSync(path.join(__dirname,"../src/createApp.js"),"utf8");
  assert.match(app,/await whatsappCoexistence\.finalizeBusinessAppEcho\(persisted\)/);
  assert.match(app,/durabilityFailures \+= 1;[\s\S]{0,250}Could not finalize WhatsApp Business App echo/);
  assert.match(app,/if \(durabilityFailures > 0\) \{[\s\S]{0,180}res\.sendStatus\(503\)/);
});
