"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {resolveModelAppointmentEvidence}=require("../src/utils/aiLedAppointmentEvidence");
const {isBriefAcceptance,hasSpecificStaffTimeOffer}=require("../src/services/staffAppointmentAcceptanceService");
const {parseTerseStaffConfirmedSlot,isTerseBookingCorroborated,createStaffBookingConfirmationService,recordModelConfirmationHold}=require("../src/services/staffBookingConfirmationService");
const {CONFIRMATION_HOLD_SQL,MODEL_CONFIRMATION_HOLD_SQL}=require("../src/db/staffAppointmentReminderRepo");
const config={businessType:"tcm_clinic",businessName:"Neutro Sense TCM Centre",aiPricingIntentMode:"enabled"};
const now=Date.parse("2026-11-26T08:39:10Z");
const offer="19/12-星期六-\n10am ok?";
const confirmation="Comfirm appointment - 19/12- Sat - 10am ya 💚☺️";
const staff=(text,id=10,at=now-60000)=>({role:"assistant",content:"[Verified STAFF message] "+text,pricingVerifiedStaffText:true,contextMessageId:id,pricingCreatedAtMs:at});
const customer=(text,id=11)=>({role:"user",content:text,contextMessageId:id,pricingCreatedAtMs:now-30000});
const parsed=(kind,quote)=>({structured:true,outcome:"normal",details:{appointmentIntent:kind,appointmentStaffEvidence:quote}});
const resolve=(history,kind,quote,extra={})=>resolveModelAppointmentEvidence({config,history,parsed:parsed(kind,quote),customerText:history.at(-1).content,inboundId:history.at(-1).contextMessageId,bookingContext:{status:"none"},now,...extra});

test("actual appointment conversation normalizes spaced acceptance and verifies exact staff-confirmed slot",async()=>{
  assert.equal(isBriefAcceptance("o k"),true);
  assert.equal(isBriefAcceptance("o k but not Saturday"),false);
  assert.equal(hasSpecificStaffTimeOffer(offer),true);
  const slot=parseTerseStaffConfirmedSlot(confirmation,new Date(now));
  assert.equal(slot,"2026-12-19T02:00:00.000Z");
  assert.equal(parseTerseStaffConfirmedSlot(confirmation.replace("Sat","Sun"),new Date(now)),null);
  const proof={id:12,created_at:new Date(now).toISOString(),prior_turns:[
    {role:"user",content:"o k",created_at:new Date(now-37000).toISOString()},
    {role:"assistant",content:offer,sent_by_username:"WhatsApp Business App",created_at:new Date(now-46000).toISOString()},
  ]};
  assert.equal(isTerseBookingCorroborated(confirmation,slot,proof.prior_turns,proof.created_at),true);
  const updates=[];
  const run=createStaffBookingConfirmationService({
    config:{...config,hours:{weekly:{saturday:{open:"10:00",close:"18:00"}}}},now:()=>new Date(now),
    database:{query:async()=>({rows:[proof]})},
    pipeline:{getActiveLeadForContact:async()=>({id:1792,appointment_status:"none",is_closed:false}),
      updateLead:async(id,patch)=>{updates.push({id,...patch});return patch;}},
  });
  await run(123,confirmation,{providerAccepted:true,messageId:12});
  assert.deepEqual(updates,[{id:1792,appointmentStatus:"set",appointmentAt:slot}]);
});

test("natural agreement is model-led but only real exact current staff offer authorizes the hold",()=>{
  const source=staff(offer),inbound=customer("That works perfectly for me, thank you");
  const history=[source,inbound];
  assert.deepEqual(resolve(history,"accepted",offer),{kind:"accepted",id:10,text:offer});
  for(const [h,k,q,extra] of [
    [history,"accepted","invented slot",{}],
    [[{...source,pricingVerifiedStaffText:false},inbound],"accepted",offer,{}],
    [[source,customer("Maybe, not sure")],"accepted",offer,{}],
    [[source,customer("Can I reschedule?")],"accepted",offer,{}],
    [history,"accepted",offer,{bookingContext:{status:"cancelled"}}],
    [history,"accepted",offer,{bookingContext:{status:"set"}}],
    [history,"accepted",offer,{parsed:{...parsed("accepted",offer),flagged:true}}],
    [[source,{role:"assistant",content:"A different offer"},inbound],"accepted",offer,{}],
    [[{...source,pricingCreatedAtMs:now-25*3600000},inbound],"accepted",offer,{}],
  ])assert.equal(resolve(h,k,q,extra),null);
});

test("missed staff confirmation can hold sales, never create a CRM slot from model text",async()=>{
  const source=staff(confirmation),inbound=customer("Thank you");
  const evidence=resolve([source,inbound],"confirmed",confirmation);
  assert.deepEqual(evidence,{kind:"confirmed",id:10,text:confirmation});
  assert.equal(resolve([staff(confirmation.replace("Sat","Sun")),inbound],"confirmed",confirmation.replace("Sat","Sun")),null);
  assert.equal(resolve([staff("Your appointment is not confirmed 19/12 10am"),inbound],"confirmed","Your appointment is not confirmed 19/12 10am"),null);
  const queries=[];
  const db={connect:async()=>({query:async(sql,args)=>{queries.push({sql,args});return {rows:sql===MODEL_CONFIRMATION_HOLD_SQL?[{id:123}]:[]};},release(){}})};
  assert.equal(await recordModelConfirmationHold(123,11,evidence,{database:db}),true);
  assert.deepEqual(queries.find(q=>q.sql===MODEL_CONFIRMATION_HOLD_SQL).args,[123,10,confirmation,11]);
  assert.match(CONFIRMATION_HOLD_SQL,/holdKind','confirmation_pending/);
  assert.match(CONFIRMATION_HOLD_SQL,/booking_hold_resolved/);
  assert.match(MODEL_CONFIRMATION_HOLD_SQL,/later.id>inbound.id/);
  assert.equal(queries.some(q=>/UPDATE leads|INSERT INTO leads/i.test(q.sql)),false);
});
