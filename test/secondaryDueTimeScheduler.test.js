"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const {
  IDLE_RECHECK_MS,ERROR_RETRY_MS,DELIVERY_RECEIPT_WAKE_DELAY_MS,
  nextAllowedClinicTime,nextSecondaryDueDelay,
  createSecondaryDueScheduler,measureSecondaryWorkerRun,
  secondaryEventRequiresWake,
}=require("../src/utils/secondaryDueTimeScheduler");
const {createAdaptiveWorkerTimer}=require("../src/utils/adaptiveWorkerTimer");
const {takeWorkerActivity}=require("../src/utils/workerActivityMetrics");
const service=require("../src/services/whatsappSecondaryFollowUpService");
const marketing=require("../src/services/whatsappSecondaryMarketingFollowUpService");

const HOUR=60*60*1000;
const time=value=>Date.parse(value);

test("sender due hints keep all consent, ad, history and one-shot gates",()=>{
 for(const sql of [service.POTENTIAL_DUE_SQL,marketing.POTENTIAL_DUE_SQL]){
  assert.match(sql,/FROM whatsapp_sender_.*followup_rules rule/);
  assert.match(sql,/whatsapp_free_entry_referrals ads_ref/);
  assert.match(sql,/whatsapp_sender_coexistence_history_messages/);
  assert.match(sql,/whatsapp_opt_out_at IS NULL/);
  assert.match(sql,/marketing_consent='opted_in'/);
  assert.match(sql,/NOT EXISTS \(/);
  assert.match(sql,/INTERVAL '8 hours'/);
  assert.match(sql,/next_due_at/);
  assert.match(sql,/has_overdue/);
  assert.doesNotMatch(sql,/LIMIT \$5/);
  assert.doesNotMatch(sql,/\$9\b/);
  if(sql===service.POTENTIAL_DUE_SQL)assert.match(sql,/\$8::timestamptz/);
  else assert.doesNotMatch(sql,/\$8\b/);
  assert.match(sql,/\$6::text/);
  assert.match(sql,/\$7::timestamptz/);
  assert.match(sql,/\$5::timestamptz/);
 }
 assert.match(service.POTENTIAL_DUE_SQL,/role='assistant'/);
 assert.match(marketing.POTENTIAL_DUE_SQL,/operator_billing_approved=TRUE/);
 for(const sql of [marketing.CANDIDATES_SQL,marketing.RECHECK_SQL,
   marketing.POTENTIAL_DUE_SQL,marketing.EXTENDED_CANDIDATES_SQL]){
   assert.match(sql,/recent_seed AS MATERIALIZED/);
   assert.match(sql,/verified_seed AS MATERIALIZED/);
   assert.match(sql,/recent_contact\.legacy_ads_eligible/);
 }
 assert.match(marketing.POTENTIAL_DUE_SQL,/consent\.consent_scope='treatment_followups_and_related_offers'/);
 assert.match(marketing.POTENTIAL_DUE_SQL,/NOT EXISTS \(\s*SELECT 1 FROM whatsapp_sender_marketing_followup_attempts/);
 assert.match(service.CANDIDATES_SQL,/BETWEEN 7 AND 23/);
 assert.match(marketing.CANDIDATES_SQL,/BETWEEN 7 AND 23/);
});

test("service candidate and hint only scan recent inbound contacts before the original safety checks",()=>{
 for(const sql of [service.CANDIDATES_SQL,service.POTENTIAL_DUE_SQL]){
  assert.match(sql,/SELECT DISTINCT recent\.contact_id/);
  assert.match(sql,/FROM messages recent[\s\S]*?recent\.created_at > \$4::timestamptz - INTERVAL '24 hours'/);
  assert.match(sql,/recent\.role='user'/);
  assert.match(sql,/recent\.whatsapp_message_id IS NOT NULL/);
  assert.match(sql,/sc\.contact_id=recent_contact\.contact_id/);
  assert.match(sql,/ORDER BY m\.created_at DESC,m\.id DESC LIMIT 1/,
   "sender-bound latest inbound still decides eligibility; shortlist is not an authorizer");
  assert.match(sql,/whatsapp_sender_coexistence_history_messages/);
  assert.match(sql,/whatsapp_opt_out_at IS NULL/);
  assert.match(sql,/appointment_status/);
  assert.match(sql,/whatsapp_sender_followup_attempts/);
 }
 assert.match(service.RECHECK_SQL,/whatsapp_sender_followup_attempts attempt/);
 assert.doesNotMatch(service.RECHECK_SQL,/recent_contact/,
   "last provider recheck stays keyed to the exact reserved inbound");
 for(const [sql, days] of [
   [marketing.CANDIDATES_SQL, 5],
   [marketing.POTENTIAL_DUE_SQL, 5],
   [marketing.RECHECK_SQL, 5],
   [marketing.EXTENDED_CANDIDATES_SQL, 9],
   [marketing.EXTENDED_RECHECK_SQL, 9],
 ]){
  assert.match(sql,/SELECT DISTINCT recent\.contact_id/);
  assert.ok(sql.includes("recent.created_at > $4::timestamptz - INTERVAL '" + days + " days'"),
   "48h/66h need five days; Day4/Day6 preserve nine days");
  assert.match(sql,/sc\.contact_id=recent_contact\.contact_id/);
  assert.match(sql,/whatsapp_marketing_consent_events consent/);
 }
});

test("scheduler shifts due sends during Malaysia quiet hours to 07:00 without delaying daytime slots",()=>{
 assert.equal(new Date(nextAllowedClinicTime(time("2026-11-01T18:00:00Z"))).toISOString(),
  "2026-11-01T23:00:00.000Z","02:00 MYT becomes 07:00 MYT");
 assert.equal(new Date(nextAllowedClinicTime(time("2026-11-02T01:12:00Z"))).toISOString(),
  "2026-11-02T01:12:00.000Z","09:12 MYT stays unchanged");
 const now=time("2026-11-01T17:00:00Z"); // 01:00 MYT
 assert.equal(nextSecondaryDueDelay({
  next_due_at:"2026-11-01T18:30:00Z",has_overdue:false,
 },now),6*HOUR,"02:30 MYT due wakes at 07:00 MYT");
 assert.equal(nextSecondaryDueDelay({
  next_due_at:null,has_overdue:true,
 },now),6*HOUR,"already overdue overnight must wake at quiet-hours end");
 assert.equal(nextSecondaryDueDelay({next_due_at:null,has_overdue:false},now),
  IDLE_RECHECK_MS,"no eligible slots means just the hourly backstop");
 assert.equal(nextSecondaryDueDelay({
  next_due_at:"2026-11-02T02:00:00Z",has_overdue:false,
 },time("2026-11-02T01:00:00Z")),HOUR);
 assert.equal(nextSecondaryDueDelay({
  next_due_at:null,has_overdue:true,
 },time("2026-11-02T01:00:00Z")),IDLE_RECHECK_MS,
 "skipped but overdue daytime work must not loop the database every second");
});

function fakeClock(initial){
 let clock=time(initial),nextId=1;
 const scheduled=new Map();
 const setTimeoutImpl=(fn,delay)=>{
  const handle={id:nextId++,unref(){}};
  scheduled.set(handle.id,{handle,fn,at:clock+delay});
  return handle;
 };
 const clearTimeoutImpl=handle=>scheduled.delete(handle?.id);
 const advance=async(ms)=>{
  const target=clock+ms;
  for(let guard=0;guard<50;guard++){
   const due=[...scheduled.values()].filter(x=>x.at<=target).sort((a,b)=>a.at-b.at)[0];
   if(!due){clock=target;return;}
   scheduled.delete(due.handle.id);
   clock=due.at;
   await due.fn();
  }
  assert.fail("timer loop must never spin");
 };
 return {now:()=>clock,advance,scheduled,createTimer:opts=>
  createAdaptiveWorkerTimer({...opts,now:()=>clock,setTimeoutImpl,clearTimeoutImpl})};
}
function fakeEvents(){
 const listeners=new Map();
 return {
  subscribe(topic,listener){
   const bucket=listeners.get(topic)||new Set();
   bucket.add(listener);listeners.set(topic,bucket);
   return()=>bucket.delete(listener);
  },
  publish(topic,payload){
   for(const fn of listeners.get(topic)||[])fn(payload);
  },
  listenerCount:topic=>listeners.get(topic)?.size||0,
 };
}

test("exact due timer sleeps, booking/opt-out events wake immediately, and stop unsubscribes",async()=>{
 const clock=fakeClock("2026-11-02T00:00:00Z");
 const events=fakeEvents();
 let runs=0,reads=0;
 const scheduler=createSecondaryDueScheduler({
  label:"Secondary due time test",
  env:{},database:{},events,
  createTimer:clock.createTimer,now:clock.now,
  run:async()=>{runs++;return {attempted:0,accepted:0};},
  readNextDue:async()=>{reads++;return{
   next_due_at:"2026-11-02T03:00:00Z",has_overdue:false,
  }},
 });
 assert.equal(scheduler.start(),true);
 await clock.advance(0);
 assert.equal(runs,1);assert.equal(reads,1);
 assert.equal(scheduler.state().dueAt,time("2026-11-02T03:00:00Z"));
 await clock.advance(30*60*1000);
 assert.equal(runs,1,"no five-minute polling while waiting for the due slot");
 events.publish("conversation_changed",{reason:"reaction",contactId:90});
 events.publish("conversation_changed",{reason:"contact_state",followUpStateUnchanged:true});
 await Promise.resolve();
 assert.equal(scheduler.state().dueAt,time("2026-11-02T03:00:00Z"));
 events.publish("conversation_changed",{reason:"message",contactId:90});
 events.publish("pipeline_changed",{contactId:90,reason:"appointment_set"});
 events.publish("conversation_changed",{reason:"booking_confirmed",contactId:90});
 await Promise.resolve();
 await clock.advance(0);
 assert.equal(runs,2,"same-turn state events cause just one immediate run");
 events.publish("pipeline_changed",{contactId:90,reason:"marketing_opt_out"});
 await Promise.resolve();await clock.advance(0);
 assert.equal(runs,3,"opt-out must immediately recompute ineligibility");
 events.publish("secondary_followup_rules_changed",{type:"marketing"});
 await Promise.resolve();await clock.advance(0);
 assert.equal(runs,4,"new or disabled rule must recompute immediately");
 scheduler.stop();
 assert.equal(events.listenerCount("conversation_changed"),0);
 assert.equal(events.listenerCount("pipeline_changed"),0);
 assert.equal(events.listenerCount("secondary_followup_rules_changed"),0);
 assert.equal(clock.scheduled.size,0);
});

test("secondary delivery status bursts defer one query but booked, opted-out and new messages wake immediately",async()=>{
 const clock=fakeClock("2026-11-02T00:00:00Z"),events=fakeEvents();
 const env={WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575"};
 let runs=0;
 const scheduler=createSecondaryDueScheduler({
  label:"Secondary receipt burst test",env,database:{},events,
  createTimer:clock.createTimer,now:clock.now,
  run:async()=>{runs++;return{attempted:0,accepted:0};},
  readNextDue:async()=>({next_due_at:"2026-11-02T03:00:00Z",has_overdue:false}),
 });
 const status={reason:"delivery_status",channel:"whatsapp",
  businessPhoneNumberId:"1318355951360575",deliveryStatus:"delivered"};
 scheduler.start();await clock.advance(0);
 assert.equal(runs,1);
 events.publish("conversation_changed",status);
 await Promise.resolve();
 assert.equal(scheduler.state().dueAt,clock.now()+DELIVERY_RECEIPT_WAKE_DELAY_MS);
 await clock.advance(1000);
 events.publish("conversation_changed",{...status,deliveryStatus:"read"});
 await Promise.resolve();
 assert.equal(scheduler.state().dueAt,
  time("2026-11-02T00:00:00Z")+DELIVERY_RECEIPT_WAKE_DELAY_MS);
 await clock.advance(DELIVERY_RECEIPT_WAKE_DELAY_MS-1001);
 assert.equal(runs,1,"repeated receipt updates must not repeatedly scan the database");
 await clock.advance(1);
 assert.equal(runs,2,"first receipt group triggers one bounded-delay check");
 events.publish("conversation_changed",status);
 await Promise.resolve();
 events.publish("pipeline_changed",{reason:"appointment_set"});
 await Promise.resolve();
 await clock.advance(0);
 assert.equal(runs,3,"booking updates override a pending receipt delay");
 events.publish("conversation_changed",status);await Promise.resolve();
 events.publish("conversation_changed",{reason:"whatsapp_opt_out"});await Promise.resolve();
 await clock.advance(0);
 assert.equal(runs,4,"opt-outs override a pending receipt delay");
 events.publish("conversation_changed",status);await Promise.resolve();
 events.publish("conversation_changed",{reason:"message",channel:"whatsapp",
  businessPhoneNumberId:"1318355951360575"});await Promise.resolve();
 await clock.advance(0);
 assert.equal(runs,5,"new customer messages remain immediate");
 scheduler.stop();
 assert.equal(clock.scheduled.size,0);
});

test("worker restart immediately checks overdue slots, then schedules the next genuine due time",async()=>{
 const clock=fakeClock("2026-11-02T00:00:00Z"),events=fakeEvents();
 let runs=0;
 const scheduler=createSecondaryDueScheduler({
  label:"Secondary restart recovery",env:{},database:{},events,
  createTimer:clock.createTimer,now:clock.now,
  run:async()=>{runs++;return{attempted:1,accepted:1};},
  readNextDue:async()=>({next_due_at:"2026-11-02T00:07:00Z",has_overdue:false}),
 });
 scheduler.start();
 await clock.advance(0);
 assert.equal(runs,1,"restart must catch up without waiting five minutes");
 await clock.advance(6*60*1000);
 assert.equal(runs,1);
 await clock.advance(60*1000);
 assert.equal(runs,2,"real due time is respected");
 scheduler.stop();
});

test("failed due lookups use existing five-minute error retry, never hot-loop",async()=>{
 const clock=fakeClock("2026-11-02T00:00:00Z"),events=fakeEvents();
 let runs=0,errors=0;
 const scheduler=createSecondaryDueScheduler({
  label:"Secondary scheduler error retry",env:{},database:{},events,
  createTimer:clock.createTimer,now:clock.now,
  logger:{error:()=>{errors++;}},
  run:async()=>{runs++;return{attempted:0,accepted:0};},
  readNextDue:async()=>{if(runs===1)throw Error("temporary Neon timeout");return null;},
 });
 scheduler.start();
 await clock.advance(0);
 assert.equal(runs,1);assert.equal(errors,1);
 await clock.advance(ERROR_RETRY_MS-1);
 assert.equal(runs,1);
 await clock.advance(1);
 assert.equal(runs,2);
 scheduler.stop();
});

test("legacy secondary metrics collect duration/failure without querying the database",async()=>{
 await measureSecondaryWorkerRun("Secondary tested passive monitor",async()=>null);
 await assert.rejects(()=>measureSecondaryWorkerRun(
  "Secondary tested passive failure",async()=>{throw Error("simulated");}),/simulated/);
 const rows=takeWorkerActivity();
 assert.equal(rows.find(r=>r.label==="Secondary tested passive monitor")?.runs,1);
 assert.equal(rows.find(r=>r.label==="Secondary tested passive failure")?.failures,1);
});

test("secondary scheduler ignores only proven unrelated inbound and CRM events",()=> {
 const env={WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575"};
 const check=(type,payload)=>secondaryEventRequiresWake(type,payload,env);
 assert.equal(check("conversation_changed",{channel:"facebook",reason:"message"}),false);
 assert.equal(check("conversation_changed",{channel:"instagram",reason:"message"}),false);
 assert.equal(check("conversation_changed",{
  channel:"whatsapp",businessPhoneNumberId:"1408739622311791",reason:"message",
 }),false,"primary sender must never awaken secondary scheduler");
 assert.equal(check("conversation_changed",{
  channel:"whatsapp",businessPhoneNumberId:"1318355951360575",reason:"message",
 }),true,"verified secondary message must wake immediately");
 assert.equal(check("conversation_changed",{reason:"message",contactId:90}),true,
  "legacy publishers with unknown sender must still wake safely");
 assert.equal(check("conversation_changed",{reason:"booking_confirmed"}),true);
 assert.equal(check("conversation_changed",{reason:"whatsapp_opt_out"}),true);
 assert.equal(check("pipeline_changed",{reason:"lead_scored"}),false);
 assert.equal(check("pipeline_changed",{reason:"meta_ad_enriched"}),false);
 assert.equal(check("pipeline_changed",{reason:"lead_assignment_recovered"}),false);
 assert.equal(check("conversation_changed",{reason:"lead_assignment_recovered"}),false);
 assert.equal(check("pipeline_changed",{reason:"appointment_set"}),true);
 assert.equal(check("pipeline_changed",{}),true);
 assert.equal(check("config_changed",{}),true);
});

test("unrelated verified events do not reschedule a genuine due slot",async()=>{
 const clock=fakeClock("2026-11-02T00:00:00Z"),events=fakeEvents();
 let runs=0;
 const scheduler=createSecondaryDueScheduler({
  label:"Secondary event routing test",
  env:{WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575"},database:{},events,
  createTimer:clock.createTimer,now:clock.now,
  run:async()=>{runs++;return{attempted:0,accepted:0};},
  readNextDue:async()=>({next_due_at:"2026-11-02T03:00:00Z",has_overdue:false}),
 });
 scheduler.start();await clock.advance(0);
 events.publish("conversation_changed",{
  channel:"whatsapp",businessPhoneNumberId:"1408739622311791",reason:"message",
 });
 events.publish("conversation_changed",{channel:"facebook",reason:"message"});
 events.publish("pipeline_changed",{reason:"lead_scored"});
 await Promise.resolve();await clock.advance(0);
 assert.equal(runs,1,"proven unrelated events must not query Neon");
 events.publish("conversation_changed",{
  channel:"whatsapp",businessPhoneNumberId:"1318355951360575",reason:"message",
 });
 await Promise.resolve();await clock.advance(0);
 assert.equal(runs,2,"secondary message still wakes immediately");
 scheduler.stop();
});
