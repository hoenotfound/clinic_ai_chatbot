"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {createIdleAwareRecoveryWorker,ACTIVE_RECOVERY_MS,EMPTY_RECOVERY_MS}=
  require("../src/utils/idleAwareRecoveryWorker");
const media=require("../src/services/whatsappSecondaryAiMediaQueue");
const mutations=require("../src/services/whatsappCoexistenceMutationService");
const echoMedia=require("../src/services/whatsappCoexistenceMediaService");
const history=require("../src/services/whatsappCoexistenceHistoryService");
const appointmentRecovery=require("../src/services/staffAppointmentReminderRecoveryService");

function fakeClock(){
 let current=0,nextId=1;
 const scheduled=new Map();
 function setTimeoutImpl(fn,delay){
   const timer={id:nextId++,unref(){}};
   scheduled.set(timer.id,{fn,due:current+delay});
   return timer;
 }
 function clearTimeoutImpl(handle){if(handle)scheduled.delete(handle.id);}
 async function advance(ms){
   current+=ms;
   while(true){
     const due=[...scheduled].filter(([,v])=>v.due<=current)
       .sort((a,b)=>a[1].due-b[1].due)[0];
     if(!due)break;
     scheduled.delete(due[0]);
     await due[1].fn();
   }
 }
 return{setTimeoutImpl,clearTimeoutImpl,now:()=>current,advance,
   pending:()=>[...scheduled.values()].map(x=>x.due).sort((a,b)=>a-b)};
}

test("empty recovery queues sleep 30 minutes, preserving a complete Neon idle interval",async()=>{
 const clock=fakeClock();
 let runs=0;
 const worker=createIdleAwareRecoveryWorker({
   run:async()=>{runs++;},
   hasPendingWork:async()=>false,
   ...clock,
 });
 worker.start(0);
 await clock.advance(0);
 assert.equal(runs,1);
 assert.deepEqual(clock.pending(),[EMPTY_RECOVERY_MS]);
 await clock.advance(5*60*1000);
 assert.equal(runs,1,"must not query Neon during the first 5 minutes");
 await clock.advance(EMPTY_RECOVERY_MS-5*60*1000);
 assert.equal(runs,2,"periodic crash recovery still runs");
 worker.stop();
});

test("hourly idle fallback keeps immediate wakes and one-minute active recovery",async()=>{
 const clock=fakeClock();
 let runs=0,hasWork=false;
 const worker=createIdleAwareRecoveryWorker({
   run:async()=>{runs++;},
   hasPendingWork:async()=>hasWork,
   emptyIntervalMs:60*60*1000,
   ...clock,
 });
 worker.start(0);
 await clock.advance(0);
 assert.deepEqual(clock.pending(),[60*60*1000]);
 await clock.advance(30*60*1000);
 assert.equal(runs,1,"empty queue must not wake Neon at 30 minutes");
 hasWork=true;
 assert.equal(worker.wake(0),true,"new work must wake immediately");
 await clock.advance(0);
 assert.equal(runs,2);
 assert.deepEqual(clock.pending(),[30*60*1000+ACTIVE_RECOVERY_MS]);
 await clock.advance(ACTIVE_RECOVERY_MS);
 assert.equal(runs,3,"active work retains one-minute recovery");
 worker.stop();
});

test("both secondary recovery producers explicitly select hourly empty fallback",()=>{
 const mediaSource=fs.readFileSync(path.join(__dirname,
   "../src/services/whatsappSecondaryAiMediaQueue.js"),"utf8");
 const mutationSource=fs.readFileSync(path.join(__dirname,
   "../src/services/whatsappCoexistenceMutationService.js"),"utf8");
 assert.match(mediaSource,/label:"Secondary WhatsApp AI media recovery",[\s\S]{0,150}errorRetryDelayMs:MEDIA_ACTIVE_CHECK_MS/);
 assert.match(mediaSource,/const RECOVERY_DEADLINE_SQL=/);
 assert.match(mediaSource,/delayForResult:result=>result.nextDelayMs/);
 assert.match(mutationSource,/label:"Business App mutation recovery",[\s\S]{0,300}emptyIntervalMs:60\*60\*1000/);
 assert.match(mediaSource,/if\(pending\.rowCount>0\)wake\(\)/);
 assert.match(mutationSource,/if\(!applied\)wake\(\)/);
});

test("pending media and edits retain exact one-minute safety cadence",async()=>{
 const clock=fakeClock();
 let runs=0;
 const worker=createIdleAwareRecoveryWorker({
   run:async()=>{runs++;},
   hasPendingWork:async()=>true,
   ...clock,
 });
 worker.start(0);
 await clock.advance(0);
 assert.deepEqual(clock.pending(),[ACTIVE_RECOVERY_MS]);
 await clock.advance(ACTIVE_RECOVERY_MS);
 assert.equal(runs,2);
 worker.stop();
});

test("new committed job wakes immediately, including from a dormant empty queue",async()=>{
 const clock=fakeClock();
 let runs=0,busy=false;
 const worker=createIdleAwareRecoveryWorker({
   run:async()=>{runs++;},
   hasPendingWork:async()=>busy,
   ...clock,
 });
 worker.start(0);
 await clock.advance(0);
 busy=true;
 assert.equal(worker.wake(0),true);
 await clock.advance(0);
 assert.equal(runs,2);
 assert.deepEqual(clock.pending(),[ACTIVE_RECOVERY_MS]);
 busy=false;
 await clock.advance(ACTIVE_RECOVERY_MS);
 assert.deepEqual(clock.pending(),[ACTIVE_RECOVERY_MS+EMPTY_RECOVERY_MS]);
 worker.stop();
});

test("failed recovery or failed queue inspection retries after one minute, never sleeps 30 minutes",async()=>{
 const clock=fakeClock();
 let runs=0,fail=true;
 const worker=createIdleAwareRecoveryWorker({
   run:async()=>{runs++;},
   hasPendingWork:async()=>{
     if(fail)throw Error("query failed");
     return false;
   },
   logger:{error(){}},
   ...clock,
 });
 worker.start(0);
 await clock.advance(0);
 assert.equal(runs,1);
 assert.deepEqual(clock.pending(),[ACTIVE_RECOVERY_MS]);
 fail=false;
 await clock.advance(ACTIVE_RECOVERY_MS);
 assert.equal(runs,2);
 assert.deepEqual(clock.pending(),[ACTIVE_RECOVERY_MS+EMPTY_RECOVERY_MS]);
 worker.stop();
});

test("sender-scoped media pending lookup includes claimed outcomes and never calls DB when off",async()=>{
 const args={
   WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
   WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
   WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
   WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
   WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30T03:00:00Z",
   WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
   WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
   WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
   WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
   WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
   WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
   WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
   WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
   WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 };
 assert.equal(media.enabled(args),true);
 let calls=0;
 const db={query:async(sql,params)=>{
   calls++;
   assert.equal(sql,media.PENDING_SQL);
   assert.match(sql,/job.state IN \('pending','claimed'\)/);
   assert.match(sql,/sender\.meta_account_id=\$3/);
   assert.deepEqual(params,["ariel","100000000000002","200000000000002"]);
   return {rows:[{has_work:true}]};
 }};
 assert.equal(await media.hasPendingWork({database:db,env:args}),true);
 assert.equal(calls,1);
 assert.equal(await media.hasPendingWork({database:db,env:{}}),false);
 assert.equal(calls,1);
 await assert.rejects(media.hasPendingWork({database:{query:async()=>({rows:[]})},env:args}),
   /status unavailable/);
});

test("mutation recovery pending lookup is sender-scoped and fails closed on missing result",async()=>{
 const env={
   WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
   WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 };
 let calls=0;
 const database={query:async(sql,params)=>{
   calls++;
   assert.equal(sql,mutations.PENDING_SQL);
   assert.match(sql,/j.status='pending'/);
   assert.match(sql,/EXISTS \(/);
   assert.match(sql,/m\.whatsapp_message_id=j\.target_wamid/);
   assert.match(sql,/mc\.conversation_id=sc\.id/);
   assert.deepEqual(params,["ariel","100000000000002","200000000000002"]);
   return {rows:[{has_work:false}]};
 }};
 assert.equal(await mutations.hasPendingWork({database,env}),false);
 assert.equal(calls,1);
 assert.equal(await mutations.hasPendingWork({database,env:{}}),false);
 assert.equal(calls,1);
 await assert.rejects(mutations.hasPendingWork({database:{query:async()=>({rows:[]})},env}),
   /status unavailable/);
});


test("unmatched Business App revoke is durable but not an every-minute Neon query",async()=>{
 const clock=fakeClock();
 const env={
   WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
   WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 };
 let queries=0,connects=0,actionable=false;
 const db={
   query:async(sql)=>{
     queries++;
     if(sql.includes("SELECT id FROM whatsapp_sender_accounts"))return{rows:[{id:8}]};
     if(sql.startsWith("SELECT id FROM whatsapp_sender_coexistence_mutations")){
       assert.match(sql,/AND EXISTS \(/);
       assert.match(sql,/m\.whatsapp_message_id=j\.target_wamid/);
       return{rows:actionable?[{id:17}]:[]};
     }
     if(sql===mutations.PENDING_SQL)return{rows:[{has_work:actionable}]};
     return{rows:[],rowCount:0};
   },
   connect:async()=>{
     connects++;
     return{query:async(sql)=>{
       if(sql===mutations.LOOKUP_SQL)return{rows:[]};
       return{rows:[],rowCount:0};
     },release(){}};
   },
 };
 let runs=0;
 const worker=createIdleAwareRecoveryWorker({
   run:async()=>{runs++;await mutations.runOnce({env,database:db});},
   hasPendingWork:()=>mutations.hasPendingWork({env,database:db}),
   ...clock,
 });
 worker.start(0);
 await clock.advance(0);
 assert.equal(runs,1);
 assert.equal(connects,0,"unmatched revoke must not run a write transaction");
 assert.deepEqual(clock.pending(),[EMPTY_RECOVERY_MS]);
 const before=queries;
 await clock.advance(5*60*1000);
 assert.equal(queries,before,"unmatched revoke must not query Neon every minute");
 actionable=true;
 assert.equal(worker.wake(0),true,"original staff echo wakes recovery");
 await clock.advance(0);
 assert.equal(runs,2);
 assert.deepEqual(clock.pending(),[5*60*1000+ACTIVE_RECOVERY_MS]);
 worker.stop();
});

test("staff echo and media queue wake only after durable commit, without provider replays",()=>{
 const mutationSource=fs.readFileSync(path.join(__dirname,
   "../src/services/whatsappCoexistenceService.js"),"utf8");
 const mediaSource=fs.readFileSync(path.join(__dirname,
   "../src/services/whatsappSecondaryAiMediaQueue.js"),"utf8");
 const mutationRepo=fs.readFileSync(path.join(__dirname,
   "../src/services/whatsappCoexistenceMutationService.js"),"utf8");
 assert.match(mutationSource,/if \(persisted\.isNew && senderAwareEchoesEnabled\(\)/);
 assert.match(mutationSource,/echoMutations\.wake\(\)/);
 assert.match(mediaSource,/await client\.query\("COMMIT"\);[\s\S]{0,240}wake\(\)/);
 assert.match(mutationRepo,/if\(!applied\)wake\(\)/);
 assert.match(mediaSource,/quarantineStaleClaims/);
 assert.match(mediaSource,/STILL_VALID_SQL/);
 assert.match(mediaSource,/isSecondaryAutomationEligible/);
});

test("Business App echo media waits an hour when empty but wakes immediately for a saved attachment",async()=>{
 const clock=fakeClock();
 const env={
   WHATSAPP_SECONDARY_COEXISTENCE_MEDIA_SYNC_ENABLED:"true",
   WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
   WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
   WHATSAPP_SECONDARY_SENDER_KEY:"secondary",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 };
 let runs=0,busy=false;
 const db={query:async(sql)=>{
   if(sql===echoMedia.PENDING_SQL)return{rows:[{has_work:busy}]};
   if(sql.includes("INSERT INTO whatsapp_sender_coexistence_media_jobs"))
     return{rowCount:1,rows:[{message_id:42}]};
   throw Error("Unexpected media query");
 }};
 assert.equal(echoMedia.start({env,database:db,run:async()=>{runs++;},...clock}),true);
 try{
   await clock.advance(0);
   assert.equal(runs,1);
   assert.deepEqual(clock.pending(),[60*60*1000]);
   await clock.advance(30*60*1000);
   assert.equal(runs,1,"no idle Neon poll at one minute or thirty minutes");
   busy=true;
   assert.equal(await echoMedia.enqueue({
     contactId:12,messageId:42,wamid:"wamid.verified-echo",
     mediaId:"verified-media",type:"image",
   },{database:db,env}),true);
   await clock.advance(0);
   assert.equal(runs,2,"durably enqueued media wakes the worker immediately");
   assert.deepEqual(clock.pending(),[30*60*1000+ACTIVE_RECOVERY_MS]);
   busy=false;
   await clock.advance(ACTIVE_RECOVERY_MS);
   assert.equal(runs,3,"active queue retains the one-minute safety check");
   assert.deepEqual(clock.pending(),[31*60*1000+60*60*1000]);
 }finally{echoMedia.stop();}
});

test("duplicate completed Business App echo media does not wake Neon again",async()=>{
 const clock=fakeClock();
 const env={
   WHATSAPP_SECONDARY_COEXISTENCE_MEDIA_SYNC_ENABLED:"true",
   WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
   WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
   WHATSAPP_SECONDARY_SENDER_KEY:"secondary",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 };
 let runs=0;
 const db={query:async(sql)=>{
   if(sql===echoMedia.PENDING_SQL)return{rows:[{has_work:false}]};
   if(sql.includes("INSERT INTO whatsapp_sender_coexistence_media_jobs"))
     return{rowCount:0,rows:[]};
   if(sql.includes("SELECT provider_media_id,media_type,status"))
     return{rows:[{provider_media_id:"verified-media",media_type:"image",status:"complete"}]};
   throw Error("Unexpected media query");
 }};
 assert.equal(echoMedia.start({env,database:db,run:async()=>{runs++;},...clock}),true);
 try{
   await clock.advance(0);
   assert.equal(runs,1);
   assert.deepEqual(clock.pending(),[60*60*1000]);
   assert.equal(await echoMedia.enqueue({
     contactId:12,messageId:42,wamid:"wamid.verified-echo",
     mediaId:"verified-media",type:"image",
   },{database:db,env}),true,"duplicate is still safe and idempotent");
   await clock.advance(0);
   assert.equal(runs,1,"completed duplicate must not start another recovery pass");
   assert.deepEqual(clock.pending(),[60*60*1000]);
 }finally{echoMedia.stop();}
});

test("signed Business App history staging wakes a sleeping importer without periodic minute polls",async()=>{
 const clock=fakeClock();
 const env={
   WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
   WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
   WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
   WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
   WHATSAPP_SECONDARY_SENDER_KEY:"secondary",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 };
 let runs=0;
 const db={query:async(sql)=>{
   if(sql===history.PENDING_SQL)return{rows:[{has_work:false}]};
   if(sql.includes("SELECT id FROM whatsapp_sender_accounts"))return{rows:[{id:11}]};
   if(sql.includes("INSERT INTO whatsapp_sender_coexistence_import_jobs"))
     return{rowCount:1,rows:[{fingerprint:"test"}]};
   throw Error("Unexpected history query");
 }};
 assert.equal(history.start({env,database:db,run:async()=>{runs++;},...clock}),true);
 try{
   await clock.advance(0);
   assert.equal(runs,1);
   assert.deepEqual(clock.pending(),[60*60*1000]);
   await clock.advance(30*60*1000);
   assert.equal(runs,1);
   const received=await history.acceptPassiveSync({entry:[{
     id:env.WHATSAPP_SECONDARY_WABA_ID,changes:[{field:"history",value:{
       metadata:{phone_number_id:env.WHATSAPP_SECONDARY_PHONE_NUMBER_ID},
       history:[],
     }}],
   }]},{database:db,env});
   assert.equal(received.staged,1);
   await clock.advance(0);
   assert.equal(runs,2,"verified durable history stage wakes the importer immediately");
   assert.deepEqual(clock.pending(),[30*60*1000+60*60*1000]);
 }finally{history.stop();}
});

test("Business App idle checks remain sender-owned and fail closed on missing results",async()=>{
 const mediaEnv={
   WHATSAPP_SECONDARY_COEXISTENCE_MEDIA_SYNC_ENABLED:"true",
   WHATSAPP_SENDER_SCOPED_INGRESS_ENABLED:"true",
   WHATSAPP_SECONDARY_INBOX_ONLY_ENABLED:"true",
   WHATSAPP_SECONDARY_SENDER_KEY:"secondary",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 };
 const historyEnv={...mediaEnv,
   WHATSAPP_SECONDARY_COEXISTENCE_HISTORY_IMPORT_ENABLED:"true",
   WHATSAPP_MULTI_NUMBER_READ_ENABLED:"true",
 };
 for(const [service,env,states] of [
   [echoMedia,mediaEnv,"'pending','claimed'"],
   [history,historyEnv,"'pending','processing'"],
 ]){
   let calls=0;
   const db={query:async(sql,args)=>{
     calls++;
     assert.equal(sql,service.PENDING_SQL);
     assert.ok(sql.includes(states));
     assert.match(sql,/sa.sender_key=\$1/);
     assert.match(sql,/sa.meta_account_id=\$3/);
     assert.deepEqual(args,["secondary","100000000000002","200000000000002"]);
     return{rows:[{has_work:false}]};
   }};
   assert.equal(await service.hasPendingWork({database:db,env}),false);
   assert.equal(calls,1);
   assert.equal(await service.hasPendingWork({database:db,env:{}}),false);
   assert.equal(calls,1,"disabled workers must never query Neon");
   await assert.rejects(service.hasPendingWork({
     database:{query:async()=>({rows:[]})},env,
   }),/pending state unavailable/);
 }
});

test("appointment reminder retains 30-minute fallback and immediate post-send wake",()=>{
 const appSource=fs.readFileSync(path.join(__dirname,
   "../src/services/staffAppointmentReminderRecoveryService.js"),"utf8");
 const inboxSource=fs.readFileSync(path.join(__dirname,
   "../src/routes/conversations.js"),"utf8");
 assert.equal(EMPTY_RECOVERY_MS,30*60*1000,
   "keep the original 30-minute recovery period rather than delaying booking repair");
 assert.doesNotMatch(appSource,/emptyIntervalMs:IDLE_APPOINTMENT_RECOVERY_MS/);
 assert.match(appSource,/run,hasPendingWork:async\(\)=>false/);
 assert.match(inboxSource,/if \(isProactiveAppointmentReminder\(text\.trim\(\)\)\) staffReminderRecovery\.wake\(\)/);
});


test("secondary AI media recovery sleeps until retries are due without missing 07:00 MYT",()=>{
 const at=s=>Date.parse(s),HOUR=60*60*1000,MIN=60*1000;
 const due="2026-11-15T23:05:00Z"; // 07:05 MYT November 16
 assert.equal(media.nextMediaRecoveryDelay({
   has_claimed:false,has_pending:false,next_pending_at:null,
 },at("2026-11-15T18:00:00Z")),HOUR);
 assert.equal(media.nextMediaRecoveryDelay({
   has_claimed:false,has_pending:true,next_pending_at:due,
 },at("2026-11-15T18:00:00Z")),HOUR,
 "02:00 MYT pending jobs need only the hourly orphan sweep");
 assert.equal(media.nextMediaRecoveryDelay({
   has_claimed:false,has_pending:true,next_pending_at:due,
 },at("2026-11-15T22:50:00Z")),10*MIN,
 "06:50 MYT worker must check at 07:00, not an hour later");
 assert.equal(media.nextMediaRecoveryDelay({
   has_claimed:false,has_pending:true,next_pending_at:due,
 },at("2026-11-15T23:02:00Z")),3*MIN,
 "07:02 MYT worker resumes at the exact pending retry");
 assert.equal(media.nextMediaRecoveryDelay({
   has_claimed:false,has_pending:true,next_pending_at:"2026-11-16T02:30:00Z",
 },at("2026-11-15T23:02:00Z")),HOUR,
 "future retries retain the hourly orphan-job fallback");
 assert.equal(media.nextMediaRecoveryDelay({
   has_claimed:false,has_pending:true,next_pending_at:"2026-11-15T23:02:00Z",
 },at("2026-11-15T23:02:00Z")),MIN,
 "due work retains one-minute crash recovery");
 assert.equal(media.nextMediaRecoveryDelay({
   has_claimed:true,has_pending:true,next_pending_at:due,
 },at("2026-11-15T18:00:00Z")),MIN,
 "claimed/unknown provider attempts must never lose minute-level quarantine");
});

test("secondary AI media scheduling fails safe on missing or corrupt recovery deadlines",()=>{
 const now=Date.parse("2026-11-15T23:10:00Z");
 for(const invalid of [null,{has_claimed:false},{has_claimed:false,has_pending:true},
   {has_claimed:false,has_pending:true,next_pending_at:"not a date"}]){
   assert.throws(()=>media.nextMediaRecoveryDelay(invalid,now),/unavailable/);
 }
});

test("media recovery deadline query stays sender-owned and does not wake disabled numbers",async()=>{
 const env={
   WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
   WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
   WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
   WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
   WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30T03:00:00Z",
   WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
   WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
   WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
   WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
   WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
   WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
   WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
   WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
   WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 };
 let calls=0;
 const database={query:async(sql,params)=>{
   calls++;
   assert.equal(sql,media.RECOVERY_DEADLINE_SQL);
   assert.match(sql,/sender\.sender_key=\$1/);
   assert.match(sql,/sender\.meta_account_id=\$3/);
   assert.match(sql,/job.state IN \('pending','claimed'\)/);
   assert.deepEqual(params,["ariel","100000000000002","200000000000002"]);
   return{rows:[{has_claimed:false,has_pending:true,
     next_pending_at:"2026-11-15T23:05:00Z"}]};
 }};
 const nowMs=Date.parse("2026-11-15T23:02:00Z");
 assert.equal(await media.readMediaRecoveryDelay({database,env,nowMs}),3*60*1000);
 assert.equal(calls,1);
 assert.equal(await media.readMediaRecoveryDelay({database,env:{},nowMs}),60*60*1000);
 assert.equal(calls,1,"disabled secondary sender must not read Neon");
 await assert.rejects(media.readMediaRecoveryDelay({
   env,database:{query:async()=>({rows:[]})},nowMs,
 }),/unavailable/);
});


test("secondary AI media worker actually schedules quiet-hour and claimed recovery with fake timers",async()=>{
 const clock=fakeClock();
 const offset=Date.parse("2026-11-15T22:50:00Z"); // 06:50 Malaysia
 const now=()=>offset+clock.now();
 const env={
   WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
   WHATSAPP_SECONDARY_SENDER_KEY:"ariel",
   WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
   WHATSAPP_SECONDARY_AUTOMATION_AUDIENCE:"ads_only",
   WHATSAPP_SECONDARY_ADS_ONLY_ACTIVATED_AT:"2026-10-30T03:00:00Z",
   WHATSAPP_SECONDARY_CLINIC_CONTENT_SOURCE:"primary",
   WHATSAPP_SECONDARY_SHARED_CLINIC_CONTENT_APPROVED:"true",
   WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
   WHATSAPP_SECONDARY_AI_MEDIA_ENABLED:"true",
   WHATSAPP_SECONDARY_SERVICE_CHARGES_ACKNOWLEDGED:"true",
   WHATSAPP_SECONDARY_AUTO_RECONCILE_ENABLED:"true",
   WHATSAPP_SECONDARY_RECEIPT_INGRESS_ENABLED:"true",
   WHATSAPP_SECONDARY_BILLING_RESERVATIONS_ENABLED:"true",
   WHATSAPP_SECONDARY_OUTBOUND_TRANSPORT_ENABLED:"true",
   WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"100000000000002",
   WHATSAPP_SECONDARY_WABA_ID:"200000000000002",
 };
 const state={has_claimed:false,has_pending:true,
   next_pending_at:"2026-11-15T23:05:00Z"};
 let runs=0,deadlineReads=0;
 const database={query:async(sql)=>{
   if(sql===media.RECOVERY_DEADLINE_SQL){
     deadlineReads++;
     return{rows:[{...state}]};
   }
   // Initial best-effort historical reconciliation must never authorize sends.
   return{rows:[],rowCount:0};
 }};
 assert.equal(media.start({env,database,run:async()=>{runs++;},...clock,now}),true);
 try{
   await clock.advance(0);
   assert.equal(runs,1);
   assert.deepEqual(clock.pending(),[10*60*1000],
     "quiet hours must wait until the 07:00 recovery boundary");
   const before=deadlineReads;
   await clock.advance(5*60*1000);
   assert.equal(runs,1);
   assert.equal(deadlineReads,before,"no unnecessary database read at 06:55");
   await clock.advance(5*60*1000);
   assert.equal(runs,2);
   assert.deepEqual(clock.pending(),[15*60*1000],
     "07:00 check must schedule the actual 07:05 retry");

   // Signed receipt or fresh durable enqueue can wake immediately, and a
   // claimed job must preserve the minute-level unknown outcome safeguard.
   state.has_claimed=true;
   assert.equal(media.wake(),true);
   await clock.advance(0);
   assert.equal(runs,3);
   assert.deepEqual(clock.pending(),[11*60*1000]);
   state.has_claimed=false;
   state.has_pending=false;
   state.next_pending_at=null;
   await clock.advance(60*1000);
   assert.equal(runs,4);
   assert.deepEqual(clock.pending(),[71*60*1000],
     "empty queues return to an hourly lost-event check");
 }finally{media.stop();}
});


test("solicited price images recover in quiet hours without waking ordinary media",()=>{
 const at=s=>Date.parse(s), MIN=60*1000,HOUR=60*MIN;
 const quiet=at("2026-11-15T22:40:00Z"); // 06:40 MYT
 const state={
   has_claimed:false,has_pending:true,next_pending_at:"2026-11-15T22:39:00Z",
   has_solicited_pending:true,next_solicited_at:"2026-11-15T22:42:00Z",
 };
 assert.equal(media.nextMediaRecoveryDelay(state,quiet),2*MIN);
 assert.equal(media.nextMediaRecoveryDelay({
   ...state,next_solicited_at:"2026-11-15T22:39:00Z",
 },quiet),MIN);
 assert.equal(media.nextMediaRecoveryDelay({
   ...state,has_solicited_pending:false,next_solicited_at:null,
 },quiet),20*MIN);
 assert.equal(media.nextMediaRecoveryDelay({
   ...state,next_solicited_at:"2026-11-16T02:40:00Z",
 },quiet),HOUR);
 assert.throws(()=>media.nextMediaRecoveryDelay({
   ...state,next_solicited_at:null,
 },quiet),/unavailable/);
 assert.match(media.RECOVERY_DEADLINE_SQL,/has_solicited_pending/);
 assert.match(media.RECOVERY_DEADLINE_SQL,/next_solicited_at/);
 assert.match(media.RECOVERY_DEADLINE_SQL,/job\.media_kind='promotion' AND job\.solicited_pricing=TRUE/);
});


test("fresh customer-requested result pictures wake overnight without polling stale media",()=>{
 const at=s=>Date.parse(s),MIN=60*1000,HOUR=60*MIN;
 const quiet=at("2026-11-16T17:05:00Z"); // 01:05 Malaysia
 const state={
   has_claimed:false,has_pending:true,
   next_pending_at:"2026-11-16T17:04:00Z",
   has_fresh_result_pending:true,
   next_fresh_result_at:"2026-11-16T17:04:00Z",
 };
 assert.equal(media.nextMediaRecoveryDelay(state,quiet),MIN,
   "fresh result images should retry promptly even after midnight");
 assert.equal(media.nextMediaRecoveryDelay({
   ...state,next_fresh_result_at:"2026-11-16T17:12:00Z",
 },quiet),7*MIN);
 assert.equal(media.nextMediaRecoveryDelay({
   ...state,has_fresh_result_pending:false,next_fresh_result_at:null,
 },quiet),HOUR,"stale overnight result images retain hourly recovery");
 assert.equal(media.nextMediaRecoveryDelay({
   ...state,has_solicited_pending:true,next_solicited_at:"2026-11-16T17:08:00Z",
   next_fresh_result_at:"2026-11-16T17:10:00Z",
 },quiet),3*MIN,"earliest authorized media wins");
 assert.throws(()=>media.nextMediaRecoveryDelay({
   ...state,next_fresh_result_at:null,
 },quiet),/unavailable/);
 assert.match(media.RECOVERY_DEADLINE_SQL,/has_fresh_result_pending/);
 assert.match(media.RECOVERY_DEADLINE_SQL,/next_fresh_result_at/);
 assert.match(media.RECOVERY_DEADLINE_SQL,/LEFT JOIN messages inbound/);
 assert.match(media.RECOVERY_DEADLINE_SQL,/job\.media_kind='result' AND inbound\.whatsapp_message_id IS NOT NULL/);
});
