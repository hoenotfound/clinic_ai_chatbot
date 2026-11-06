const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseStaffConfirmedSlot,
  parseTerseStaffConfirmedSlot,
  isTerseBookingCorroborated,
  isStaffVisitAcknowledgement,
  isProactiveAppointmentReminder,
  createStaffBookingConfirmationService,
} = require("../src/services/staffBookingConfirmationService");

const NOW = new Date("2026-10-13T05:00:00.000Z");

test("only explicit staff-confirmed full calendar appointments are eligible for CRM sync", () => {
  assert.equal(parseStaffConfirmedSlot("您的预约已确认：17/10/2026 下午4点 😊", NOW),
    "2026-10-17T08:00:00.000Z");
  assert.equal(parseStaffConfirmedSlot("Appointment confirmed: 2026-10-17 at 4:30pm", NOW),
    "2026-10-17T08:30:00.000Z");
  assert.equal(parseStaffConfirmedSlot("预约已确认 17/10/2026 16:00", NOW),
    "2026-10-17T08:00:00.000Z");
  for (const message of [
    "星期六，4点的时间你方便吗？",
    "预约已确认 星期六 下午4点",
    "Your appointment is not confirmed: 17/10/2026 4:00pm",
    "Appointment confirmed? 17/10/2026 4:00pm",
    "Your appointment confirmed 17/10/2026 4:00pm was cancelled",
    "待确认 17/10/2026 4:00pm 预约",
    "预约已确认 31/02/2027 4:00pm",
    "预约已确认 17/10/2026 4点",
    "预约已确认 17/10/2026 4:00",
  ]) {
    assert.equal(parseStaffConfirmedSlot(message, NOW), null, message);
  }
});

test("provider-accepted explicit staff confirmation sets the CRM booked date and status", async () => {
  const calls = [];
  const service = createStaffBookingConfirmationService({
    config: { businessType: "tcm_clinic" },
    now: () => NOW,
    pipeline: {
      getActiveLeadForContact: async (contactId) => {
        calls.push(["lookup", contactId]);
        return { id: 77, appointment_status: "none", is_closed: false };
      },
      updateLead: async (id, patch, actor) => {
        calls.push(["update", id, patch, actor]);
        return { id, ...patch };
      },
    },
  });
  const result = await service(372, "您的预约已确认：17/10/2026 下午4点", { providerAccepted: true });
  assert.equal(result.appointmentStatus, "set");
  assert.deepEqual(calls, [
    ["lookup", 372],
    ["update", 77, { appointmentStatus: "set", appointmentAt: "2026-10-17T08:00:00.000Z" }, "Staff chat confirmation"],
  ]);
});

test("failed or ambiguous sends cannot change booking records", async () => {
  const calls = [];
  const service = createStaffBookingConfirmationService({
    config: { businessType: "tcm_clinic" }, now: () => NOW,
    pipeline: {
      getActiveLeadForContact: async () => { calls.push("lookup"); return null; },
      updateLead: async () => { throw new Error("must not update"); },
    },
  });
  assert.equal(await service(372, "您的预约已确认：17/10/2026 下午4点", { providerAccepted: false }), null);
  assert.equal(await service(372, "星期六4点方便吗?", { providerAccepted: true }), null);
  assert.deepEqual(calls, []);
});

test("closed, visited or cancelled lead is not reopened by a staff message", async () => {
  for (const appointment_status of ["visited", "cancelled"]) {
    const service = createStaffBookingConfirmationService({
      config: { businessType: "tcm_clinic" }, now: () => NOW,
      pipeline: {
        getActiveLeadForContact: async () => ({ id: 5, is_closed: false, appointment_status }),
        updateLead: async () => { throw new Error("must not update"); },
      },
    });
    assert.equal(await service(5, "预约已确认 17/10/2026 下午4点", { providerAccepted: true }), null);
  }
});

test("staff visit acknowledgment requires a concrete visit day", () => {
  for (const s of ["See u tmr", "See u, Thursday 1pm", "好的明天见",
    "预约已确认 10/11 10:30am", "Comfirm this sat 3.30pm 😊",
    "OK 29/11, 3pm", "Confirmed next Sun 2pm"]) assert.equal(isStaffVisitAcknowledgement(s),true,s);
  for (const s of ["See u", "See u if you want", "See u tomorrow maybe",
    "Your booking was cancelled", "29/11, 3pm?", "OK noted",
    "Can 29/11 3pm?", "Confirm this Saturday", "OK next year maybe"]) assert.equal(isStaffVisitAcknowledgement(s),false,s);
});

test("two provider-authenticated terse staff confirmations have unambiguous dates",async()=>{
 const now=new Date("2026-11-04T04:06:00Z");
 assert.equal(parseTerseStaffConfirmedSlot("Comfirm this sat 3.30pm 😊",now),"2026-11-07T07:30:00.000Z");
 assert.equal(parseTerseStaffConfirmedSlot("OK 29/11, 3pm",now),"2026-11-29T07:00:00.000Z");
 assert.equal(isTerseBookingCorroborated("OK 29/11, 3pm","2026-11-29T07:00:00.000Z",[],"2026-11-04T04:47:31Z"),false);
 for(const value of ["this sat 3.30pm can?","29/11, 3pm?", "OK this sat 3pm", "Comfirm next sat 3.30pm","OK 29/11", "OK 29/11, 3pm maybe"]){
  assert.equal(parseTerseStaffConfirmedSlot(value,now),null,value);
 }
 const calls=[];
 const context={
 7245:{id:16834,created_at:"2026-11-04T04:06:40Z",prior_turns:[
  {role:"user",content:"yes, can",created_at:"2026-11-04T04:05:15Z"},
  {role:"assistant",content:"this sat 3.30pm can?",sent_by_username:"WhatsApp Business App",created_at:"2026-11-04T04:03:54Z"}]},
 1046:{id:16870,created_at:"2026-11-04T04:47:31Z",prior_turns:[
  {role:"user",content:"3pm",created_at:"2026-11-04T04:46:50Z"},
  {role:"user",content:"29/11 afternoon, any slot?",created_at:"2026-11-02T16:11:12Z"}]},
 };
 const service=createStaffBookingConfirmationService({
  config:{businessType:"tcm_clinic"},now:()=>now,
  database:{query:async(sql,args)=>({rows:context[args[0]]?[context[args[0]]]:[]})},
  pipeline:{getActiveLeadForContact:async()=>({id:45,appointment_status:"none",is_closed:false}),
   updateLead:async(id,data)=>{calls.push({id,data});return data;}},
 });
 assert.equal(await service(7245,"Comfirm this sat 3.30pm 😊",{providerAccepted:false}),null);
 await service(7245,"Comfirm this sat 3.30pm 😊",{providerAccepted:true});
 await service(1046,"OK 29/11, 3pm",{providerAccepted:true});
 assert.deepEqual(calls.map(x=>x.data.appointmentAt),
  ["2026-11-07T07:30:00.000Z","2026-11-29T07:00:00.000Z"]);
});

test("staff acknowledgment is held for review, not automatically booked", async () => {
  const events=[];
  const service=createStaffBookingConfirmationService({
    config:{businessType:"tcm_clinic"},now:()=>NOW,
    database:{query:async(sql)=>{events.push(sql);return {rows:[{id:200}]};}},
    markPendingBooking:async(contactId,messageId,options)=>{
      events.push({contactId,messageId,options});return {review:true};
    },
    pipeline:{
      getActiveLeadForContact:async()=>{throw Error("No CRM booking");},
      updateLead:async()=>{throw Error("No CRM booking");},
    },
  });
  assert.equal(await service(7,"See u tmr",{providerAccepted:false}),null);
  assert.equal(events.length,0);
  assert.deepEqual(await service(7,"See u tmr",{providerAccepted:true}),{review:true});
  assert.equal(events[1].messageId,200);
  assert.match(events[0],/whatsapp_message_id IS NOT NULL/);
});

test("informal Business App date confirmation creates a hold, not a booked lead", async () => {
  const reviews = [];
  const service = createStaffBookingConfirmationService({
    config: {businessType:"tcm_clinic"},
    now: () => new Date("2026-11-05T00:00:00Z"),
    database: {query:async()=>({rows:[{id:199}]})},
    markPendingBooking:async(contactId,messageId,options)=>{
      reviews.push({contactId,messageId,options});return {pending:true};
    },
    pipeline: {
      getActiveLeadForContact:async()=>{throw Error("must not automatically set appointment");},
      updateLead:async()=>{throw Error("must not automatically set appointment");},
    },
  });
  assert.deepEqual(await service(7245,"See u, Thursday 1pm",{providerAccepted:true}),{pending:true});
  assert.equal(reviews[0].contactId,7245);
  assert.equal(reviews[0].messageId,199);
  assert.equal(reviews[0].options.details.appointmentPreference,"See u, Thursday 1pm");
  assert.equal(await service(7245,"Can this sat 3.30pm?",{providerAccepted:true}),null);
});


test("newer customer booking date overrides an older date even if the time matches",async()=>{
 const staffAt="2026-11-04T04:47:31Z";
 const proposed="2026-11-29T07:00:00.000Z";
 const turns=[
  {role:"user",content:"29/11 afternoon, any slot?",created_at:"2026-11-02T16:11:12Z"},
  {role:"user",content:"30/11 at 3pm instead",created_at:"2026-11-04T04:46:50Z"},
 ];
 assert.equal(isTerseBookingCorroborated("OK 29/11, 3pm",proposed,turns,staffAt),false);
 assert.equal(isTerseBookingCorroborated("OK 30/11, 3pm","2026-11-30T07:00:00.000Z",turns,staffAt),true);
 const sameDate=[
  turns[0],{...turns[1],content:"29/11 at 3pm, please"},
 ];
 assert.equal(isTerseBookingCorroborated("OK 29/11, 3pm",proposed,sameDate,staffAt),true);
 const wrongYear=[
  {role:"user",content:"29/11/2025, 3pm",created_at:"2026-11-04T04:46:50Z"},
 ];
 assert.equal(isTerseBookingCorroborated("OK 29/11, 3pm",proposed,wrongYear,staffAt),false);
 const reviews=[],updates=[];
 const service=createStaffBookingConfirmationService({
  config:{businessType:"tcm_clinic"},now:()=>new Date("2026-11-04T04:47:32Z"),
  database:{query:async()=>({rows:[{id:808,created_at:staffAt,prior_turns:turns}]})},
  markPendingBooking:async(contactId,messageId)=>{reviews.push([contactId,messageId]);return{review:true};},
  pipeline:{
   getActiveLeadForContact:async()=>{throw Error("No auto-booking for conflicting date");},
   updateLead:async(...args)=>{updates.push(args);throw Error("No CRM update");},
  },
 });
 assert.deepEqual(await service(1046,"OK 29/11, 3pm",{providerAccepted:true}),{review:true});
 assert.deepEqual(reviews,[[1046,808]]);
 assert.deepEqual(updates,[]);
});


test("informal Business App appointment reminders hold follow-ups in English, Chinese and Malay", () => {
  for(const text of [
    "Morning dear remind appointment tmr 11.30am 😊",
    "Reminder: your appointment is tomorrow at 11:30am",
    "Your appointment is confirmed for Saturday at 11:30am",
    "Appointment set for Saturday 11.30am",
    "Booked for Saturday 11:30am, see you there!",
    "See you tomorrow at 11:30am 😊",
    "预约提醒：明天11:30见 😊",
    "您的预约已确认，星期六11:30见",
    "明天11:30见哦 😊",
    "Peringatan temujanji anda esok pukul 11.30 pagi",
    "Jangan lupa janji temu esok pukul 11.30 pagi",
    "Temujanji anda disahkan Sabtu 11.30 pagi",
  ])assert.equal(isProactiveAppointmentReminder(text),true,text);
  for(const text of [
    "Do you want to book an appointment?",
    "We have an appointment slot tomorrow 11.30am",
    "New appointment availability tomorrow 11.30am",
    "Appointment promotion RM388, book now",
    "If you want, see you tomorrow at 11.30am?",
    "Your appointment is not confirmed for Saturday",
    "We need to reschedule your appointment tomorrow",
    "Happy birthday dear, our complimentary appointment is available",
    "See you soon dear",
  ])assert.equal(isProactiveAppointmentReminder(text),false,text);
});

test("proactive reminder writes a durable hold without silently marking CRM booked",async()=>{
  const sqls=[];
  const service=createStaffBookingConfirmationService({
    config:{businessType:"tcm_clinic"},
    database:{query:async(sql,args)=>{
      sqls.push({sql,args});
      return {rows:[{id:100}]};
    }},
    pipeline:{getActiveLeadForContact:async()=>{throw Error("No inferred booking");},
      updateLead:async()=>{throw Error("No inferred booking");}},
    markPendingBooking:async()=>{throw Error("No alert for a routine reminder");},
  });
  assert.equal(await service(1005,"Morning dear remind appointment tmr 11.30am 😊",{providerAccepted:false}),null);
  assert.equal(sqls.length,0);
  assert.equal(await service(1005,"Morning dear remind appointment tmr 11.30am 😊",{providerAccepted:true}),null);
  assert.equal(sqls.length,1);
  assert.deepEqual(sqls[0].args,[1005,"Morning dear remind appointment tmr 11.30am 😊"]);
  assert.match(sqls[0].sql,/INSERT INTO lead_activities/);
  assert.match(sqls[0].sql,/staff_appointment_reminder/);
  assert.match(sqls[0].sql,/staff.whatsapp_message_id IS NOT NULL/);
  assert.match(sqls[0].sql,/staff.is_automated_follow_up IS DISTINCT FROM TRUE/);
  assert.match(sqls[0].sql,/NOT IN \('set','visited','cancelled'\)/);
  assert.match(sqls[0].sql,/NOT EXISTS/);
});
