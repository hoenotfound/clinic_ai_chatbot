"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const recovery=require("../src/services/staffAppointmentReminderRecoveryService");

test("Inbox reminder repair uses accepted provider messages and never re-sends anything",async()=>{
  const calls=[];
  const result=await recovery.runOnce({
    config:{businessType:"tcm_clinic"},
    database:{query:async(sql)=>{
      calls.push({sql});
      return {rows:[
        {id:17279,contact_id:1005,content:"Morning dear remind appointment tmr 11.30am 😊"},
        {id:17280,contact_id:1006,content:"We have an appointment slot tomorrow at 11.30am"},
        {id:17281,contact_id:1007,content:"Confirmed your appointment for tomorrow at 11.30am"},
      ]};
    }},
    record:async(contactId,content,options)=>calls.push({contactId,content,options}),
  });
  assert.equal(result.scanned,3);
  assert.equal(result.eligible,2);
  assert.deepEqual(calls.slice(1).map(x=>x.options),[
    {providerAccepted:true,messageId:17279},
    {providerAccepted:true,messageId:17281},
  ]);
  assert.match(recovery.RECOVERY_SQL,/m\.whatsapp_message_id IS NOT NULL/);
  assert.match(recovery.RECOVERY_SQL,/m\.is_forwarded IS DISTINCT FROM TRUE/);
  assert.match(recovery.RECOVERY_SQL,/m\.delivery_status IS DISTINCT FROM 'failed'/);
  assert.match(recovery.RECOVERY_SQL,/m\.sent_by_username NOT IN/);
  assert.match(recovery.RECOVERY_SQL,/NOW\(\)-INTERVAL '48 hours'/);
  assert.doesNotMatch(recovery.RECOVERY_SQL,/INSERT INTO messages|sendText|sendTemplate/);
});
test("nonclinic accounts do not scan for staff appointment reminders",async()=>{
  let queried=false;
  const x=await recovery.runOnce({config:{businessType:"generic"},database:{
    query:async()=>{queried=true;throw Error("must not query");},
  }});
  assert.equal(x.disabled,true);
  assert.equal(queried,false);
});
test("Inbox booking failures wake repair instead of sending an accepted staff message again",()=>{
  const route=fs.readFileSync(path.join(__dirname,"../src/routes/conversations.js"),"utf8");
  const startup=fs.readFileSync(path.join(__dirname,"../src/services/applicationStartup.js"),"utf8");
  assert.match(route,/if \(isProactiveAppointmentReminder\(text\.trim\(\)\)\) staffReminderRecovery\.wake\(\)/);
  assert.match(startup,/staffReminderRecovery\.start\(\)/);
  assert.ok(startup.indexOf("staffReminderRecovery.start()")>startup.indexOf("await initSchema()"));
});
