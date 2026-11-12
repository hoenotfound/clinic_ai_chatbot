"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {createIdleAwareRecoveryWorker,ACTIVE_RECOVERY_MS,EMPTY_RECOVERY_MS}=
  require("../src/utils/idleAwareRecoveryWorker");
const media=require("../src/services/whatsappSecondaryAiMediaQueue");
const mutations=require("../src/services/whatsappCoexistenceMutationService");

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
 assert.match(mediaSource,/isSecondaryMediaEligible/);
 assert.match(mediaSource,/secondaryAutomationEligibleSql/);
 assert.match(mediaSource,/secondaryAutomationAttentionAllowedSql/);
});
