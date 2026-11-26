"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {resolveModelAppointmentEvidence}=require("../src/utils/aiLedAppointmentEvidence");
const {isBriefAcceptance,hasSpecificStaffTimeOffer}=require("../src/services/staffAppointmentAcceptanceService");
const {parseTerseStaffConfirmedSlot,isTerseBookingCorroborated,createStaffBookingConfirmationService,recordModelConfirmationHold}=require("../src/services/staffBookingConfirmationService");
const {CONFIRMATION_HOLD_SQL,MODEL_CONFIRMATION_HOLD_SQL}=require("../src/db/staffAppointmentReminderRepo");
const config={businessType:"tcm_clinic",businessName:"Neutro Sense TCM Centre",aiPricingIntentMode:"enabled",hours:{weekly:{monday:null,tuesday:{open:"10:00",close:"20:00"},wednesday:{open:"10:00",close:"20:00"},thursday:{open:"10:00",close:"20:00"},friday:{open:"10:00",close:"20:00"},saturday:{open:"10:00",close:"18:00"},sunday:{open:"10:00",close:"18:00"}}}};
const now=Date.parse("2026-11-26T08:39:10Z");
const offer="19/12-星期六-\n10am ok?";
const confirmation="Comfirm appointment - 19/12- Sat - 10am ya 💚☺️";
const staff=(text,id=10,at=now-60000)=>({role:"assistant",content:"[Verified STAFF message] "+text,pricingVerifiedStaffText:true,contextMessageId:id,pricingCreatedAtMs:at});
const customer=(text,id=11)=>({role:"user",content:text,contextMessageId:id,pricingCreatedAtMs:now-30000});
const parsed=(kind,quote)=>({structured:true,outcome:"normal",details:{appointmentScheduling:true,appointmentIntent:kind,appointmentStaffEvidence:quote}});
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


test("appointment recognition remains independent of pricing and rejects invalid or stale evidence",()=>{
  const inbound=customer("That works perfectly for me");
  for(const aiPricingIntentMode of ["off","shadow","enabled"]){
    assert.ok(resolve([staff(offer),inbound],"accepted",offer,{config:{...config,aiPricingIntentMode}}));
  }
  assert.equal(resolve([staff(offer),inbound],"accepted",offer,{config:{...config,aiAppointmentRecognition:false}}),null);
  for(const bad of ["31/02 10am ok?","19/12 9am ok?","21/12 10am ok?","19/12 Sun 10am ok?","19/12 10am or 11am ok?","19/12 10am not available for appointment"]){
    assert.equal(resolve([staff(bad),inbound],"accepted",bad),null,bad);
  }
  assert.equal(resolve([staff(offer),customer("I like the 3D treatment")],"accepted",offer,{parsed:{...parsed("accepted",offer),serviceQuery:true}}),null);
  assert.equal(resolve([staff(confirmation,8),customer("20/12 11am please",9),staff("20/12 11am it is",10),customer("Thank you")],"confirmed",confirmation),null);
  assert.match(CONFIRMATION_HOLD_SQL,/UPDATE contacts c SET needs_attention=true/);
  assert.match(CONFIRMATION_HOLD_SQL,/attention_reason LIKE 'Booking ready:%'/);
});

test("old, forwarded, or unrelated staff offers cannot corroborate an appointment",()=>{
  const slot="2026-12-19T02:00:00.000Z";
  const turn=(role,content,seconds,staff=false)=>({role,content,created_at:new Date(now+seconds*1000).toISOString(),sent_by_username:staff?"WhatsApp Business App":null});
  const accepted=turn("user","o k",-10);
  const source=turn("assistant",offer,-20,true);
  assert.ok(isTerseBookingCorroborated(confirmation,slot,[turn("assistant","好的，收到",-2),accepted,source],new Date(now).toISOString()));
  for(const intervening of ["20/12 11am ok?","RM388 for this treatment, okay?"]){
    assert.equal(isTerseBookingCorroborated(confirmation,slot,[accepted,turn("assistant",intervening,-15,true),source],new Date(now).toISOString()),false);
  }
  assert.equal(isTerseBookingCorroborated(confirmation,slot,[accepted,{...source,is_forwarded:true}],new Date(now).toISOString()),false);
});


test("historical reconciliation is dry-run by default and never overwrites changed appointment evidence",async()=>{
  const {reconcileStaffAppointment}=require("../src/services/staffAppointmentReconciliationService");
  const row={lead_id:1792,contact_id:123,appointment_status:"none",appointment_at:null,is_closed:false,
    updated_at:new Date(now-120000).toISOString(),staff_message_id:12,staff_text:confirmation,staff_at:new Date(now).toISOString(),
    latest_message_id:20,prior_turns:[
      {role:"assistant",content:"已记下",created_at:new Date(now-20000).toISOString()},
      {role:"user",content:"o k",created_at:new Date(now-37000).toISOString()},
      {role:"assistant",content:offer,sent_by_username:"WhatsApp Business App",created_at:new Date(now-46000).toISOString()}
    ],later_turns:[{role:"user",content:"谢谢",created_at:new Date(now+1000).toISOString()}]};
  let current=row;
  const updates=[];
  const opts={config,now:new Date(now+60000),leadId:1792,staffMessageId:12,
    database:{query:async()=>({rows:[current]})},
    pipeline:{updateLead:async(...args)=>{updates.push(args);return {id:1792};}}};
  const report=await reconcileStaffAppointment(opts);
  assert.equal(report.status,"verified_dry_run");
  assert.equal(report.appointmentAt,"2026-12-19T02:00:00.000Z");
  assert.equal(updates.length,0);
  const applied=await reconcileStaffAppointment({...opts,apply:true});
  assert.equal(applied.status,"reconciled");
  assert.equal(updates[0][3].expectedBookingRecovery.latestMessageId,20);
  current={...row,later_turns:[...row.later_turns,{role:"user",content:"20/12 11am please",created_at:new Date(now+2000).toISOString()}]};
  assert.equal((await reconcileStaffAppointment({...opts,apply:true})).status,"manual_review_required");
  current={...row,appointment_status:"set"};
  assert.equal((await reconcileStaffAppointment({...opts,apply:true})).status,"manual_review_required");
  assert.equal(updates.length,1);
});
