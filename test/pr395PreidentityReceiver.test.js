"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const http=require("node:http");
const {enabled,inspectPreidentityBatch,acceptPreidentityBatch}=
  require("../src/services/pr395PreidentityReceiver");
const {configFromEnv,createRelayServer}=require("../src/services/whatsappAppDefaultRelay");
const appSecret="only-a-synthetic-app-secret-for-preidentity-tests";
const QA_PHONE="+60120000000",QA_ACCOUNT="333333333333333";
const LEGACY_ACCOUNT="111111111111111";
function env(overrides={}){
 return{
  PR395_STAGING_MODE:"true",
  PR395_STAGING_PREIDENTITY_RECEIVER_ENABLED:"true",
  PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"false",
  PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"false",
  WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:QA_PHONE,
  PR395_STAGING_APPROVED_TEST_PHONE_E164:QA_PHONE,
  WHATSAPP_PHONE_NUMBER:"+60129998888",
  WHATSAPP_WABA_ID:LEGACY_ACCOUNT,
  WHATSAPP_APP_SECRET:appSecret,META_APP_SECRET:appSecret,
  WHATSAPP_SECONDARY_WABA_ID:"",WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"",
  WHATSAPP_SECONDARY_EXPECTED_WABA_ID:"",
  WHATSAPP_SECONDARY_EXPECTED_PHONE_NUMBER_ID:"",
  ...overrides
 };
}
function qa(event="PARTNER_REMOVED",number=QA_PHONE){
 return{object:"whatsapp_business_account",entry:[{
  id:QA_ACCOUNT,time:1800000000,changes:[{
   field:"account_update",value:{event,phone_number:number,
    disconnection_info:{reason:"synthetic"}}}
  ]}]};
}
function legacy(){
 return{object:"whatsapp_business_account",entry:[{
  id:LEGACY_ACCOUNT,changes:[{field:"account_update",
   value:{event:"ACCOUNT_VIOLATION"}}]
 }]};
}
function fakeDb(){
 const state={events:new Map(),queries:[],commits:0,rollbacks:0,failWrite:false};
 const database={connect:async()=>({
  async query(sql,args=[]){
   state.queries.push({sql,args});
   if(sql==="BEGIN")return{rowCount:0};
   if(sql==="COMMIT"){state.commits++;return{rowCount:0};}
   if(sql==="ROLLBACK"){state.rollbacks++;return{rowCount:0};}
   if(sql.includes("INSERT INTO whatsapp_coexistence_preidentity_events")){
    if(state.failWrite)throw Error("synthetic storage outage");
    const fingerprint=args[0];
    if(state.events.has(fingerprint))return{rowCount:0,rows:[]};
    state.events.set(fingerprint,args);
    return{rowCount:1,rows:[{fingerprint}]};
   }
   throw Error("Unexpected SQL issued by preidentity receiver");
  },
  release(){}
 })};
 return{database,state};
}
function signature(raw){
 return"sha256="+crypto.createHmac("sha256",appSecret).update(raw).digest("hex");
}
async function listen(srv){
 await new Promise((resolve,reject)=>{
  srv.once("error",reject);srv.listen(0,"127.0.0.1",resolve);
 });
 return "http://127.0.0.1:"+srv.address().port;
}
async function close(srv){
 if(!srv.listening)return;
 srv.closeAllConnections();
 await new Promise(resolve=>srv.close(resolve));
}

test("preidentity listener rejects a foreign sender and ambiguous/mixed events BEFORE SQL",async()=>{
 const store=fakeDb();
 assert.equal(enabled(env()),true);
 for(const bad of [
  qa("PARTNER_REMOVED","+60129998888"),
  {...qa(),entry:[{...qa().entry[0],id:LEGACY_ACCOUNT}]},
  {...qa(),entry:[{...qa().entry[0],changes:[{field:"messages",value:{messages:[]}}]}]},
  {...qa(),entry:[{...qa().entry[0],changes:[{field:"account_update",value:{event:"PARTNER_REMOVED"}}]}]},
  {...qa(),entry:[...qa().entry,...legacy().entry]},
 ]){
  await assert.rejects(acceptPreidentityBatch(bad,{database:store.database,env:env()}));
 }
 assert.equal(store.state.queries.length,0);
 for(const overrides of [
  {PR395_STAGING_MODE:"false"},
  {PR395_STAGING_PREIDENTITY_RECEIVER_ENABLED:"false"},
  {PR395_STAGING_PROVIDER_REHEARSAL_ENABLED:"true"},
  {WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"111111111111111"},
  {WHATSAPP_SECONDARY_WABA_ID:QA_ACCOUNT},
  {WHATSAPP_APP_SECRET:"different"},
  {WHATSAPP_SECONDARY_SENDER_KEY:"tcm_wellness"},
 ]){
  assert.equal(enabled(env(overrides)),false);
 }
});
test("signed preidentity audit is idempotent, omits raw business payload and awaits COMMIT",async()=>{
 const store=fakeDb(),source=env();
 const first=await acceptPreidentityBatch(qa(),{database:store.database,env:source});
 assert.deepEqual(first,{durable:true,inserted:1,accepted:1});
 assert.equal(store.state.commits,1);
 const second=await acceptPreidentityBatch(qa(),{database:store.database,env:source});
 assert.deepEqual(second,{durable:true,inserted:0,accepted:1});
 assert.equal(store.state.events.size,1);
 const vals=Array.from(store.state.events.values())[0];
 assert.equal(vals[1],QA_ACCOUNT);
 assert.equal(vals[2],QA_PHONE);
 assert.equal(vals[3],"PARTNER_REMOVED");
 assert.equal(vals.length,5);
 assert.equal(JSON.stringify(vals).includes("disconnection_info"),false);
 store.state.failWrite=true;
 await assert.rejects(acceptPreidentityBatch(qa("ACCOUNT_RECONNECTED"),{
  database:store.database,env:source
 }),/synthetic storage outage/);
 assert.equal(store.state.rollbacks,1);
});
test("bootstrap relay enforces explicit legacy WABA allowlist and matching QA E164",()=>{
 const config=configFromEnv({
  WHATSAPP_DEFAULT_RELAY_BOOTSTRAP_MODE:"true",
  WHATSAPP_DEFAULT_RELAY_APP_SECRET:appSecret,
  WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN:"synthetic-long-verify-token",
  WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:LEGACY_ACCOUNT,
  WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164:QA_PHONE,
  WHATSAPP_DEFAULT_RELAY_LEGACY_URL:"https://legacy.example.invalid/webhook",
  WHATSAPP_DEFAULT_RELAY_PREIDENTITY_URL:"https://qa.example.invalid/pr395-preidentity-webhook"
 });
 assert.equal(config.secondaryWaba,"");
 assert.deepEqual(config.bootstrap.legacyWabas,[LEGACY_ACCOUNT]);
 assert.throws(()=>configFromEnv({
  WHATSAPP_DEFAULT_RELAY_BOOTSTRAP_MODE:"true",
  WHATSAPP_DEFAULT_RELAY_APP_SECRET:appSecret,
  WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN:"synthetic-long-verify-token",
  WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:"",
  WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164:QA_PHONE,
  WHATSAPP_DEFAULT_RELAY_LEGACY_URL:"https://legacy.example.invalid/webhook",
  WHATSAPP_DEFAULT_RELAY_PREIDENTITY_URL:"https://qa.example.invalid/pr395-preidentity-webhook"
 }),/fully configured/);
});
test("signed REAL HTTP relay and QA receiver commit before acknowledged, preserving known legacy events",async()=>{
 const store=fakeDb(),source=env();
 const state={legacy:0,qa:0,ack:true};
 const legacySrv=http.createServer(async(req,res)=>{
  let raw=[];for await(const part of req)raw.push(part);
  const buffer=Buffer.concat(raw);
  if(signature(buffer)!==req.headers["x-hub-signature-256"]){
   res.writeHead(403).end();return;
  }
  const p=JSON.parse(buffer.toString());
  assert.ok(p.entry.every(x=>x.id===LEGACY_ACCOUNT));
  state.legacy++;res.writeHead(200).end();
 });
 const qaSrv=http.createServer(async(req,res)=>{
  let raw=[];for await(const part of req)raw.push(part);
  const buffer=Buffer.concat(raw);
  if(signature(buffer)!==req.headers["x-hub-signature-256"]||
     req.url!=="/pr395-preidentity-webhook"){
   res.writeHead(403).end();return;
  }
  try{
   await acceptPreidentityBatch(JSON.parse(buffer.toString()),{
    env:source,database:store.database
   });
   state.qa++;
   res.writeHead(200,state.ack?{
    "x-da-coexistence-preidentity-accepted":"1"
   }:{}).end();
  }catch(_){res.writeHead(503).end();}
 });
 let relay;
 try{
  const oldBase=await listen(legacySrv),qaBase=await listen(qaSrv);
  const config=configFromEnv({
   WHATSAPP_DEFAULT_RELAY_BOOTSTRAP_MODE:"true",
   WHATSAPP_DEFAULT_RELAY_APP_SECRET:appSecret,
   WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN:"synthetic-long-verify-token",
   WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:LEGACY_ACCOUNT,
   WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164:QA_PHONE,
   WHATSAPP_DEFAULT_RELAY_LEGACY_URL:"https://legacy.example.invalid/webhook",
   WHATSAPP_DEFAULT_RELAY_PREIDENTITY_URL:"https://qa.example.invalid/pr395-preidentity-webhook"
  });
  const targets=new Map([
   [config.legacyUrl,oldBase+"/webhook"],
   [config.bootstrap.preidentityUrl,qaBase+"/pr395-preidentity-webhook"]
  ]);
  relay=createRelayServer(config,{fetchImpl:(url,options)=>{
   if(!targets.has(url))throw Error("No external network permitted in isolated test");
   return fetch(targets.get(url),options);
  }});
  const base=await listen(relay);
  const send=async(body,invalid=false)=>{
   const raw=Buffer.from(JSON.stringify(body));
   return fetch(base+"/webhook",{method:"POST",headers:{
    "content-type":"application/json",
    "x-hub-signature-256":invalid?"sha256=invalid":signature(raw)
   },body:raw});
  };
  const mixed={object:"whatsapp_business_account",entry:[
   ...legacy().entry,...qa().entry
  ]};
  assert.equal((await send(mixed,true)).status,403);
  assert.equal(state.legacy,0);
  assert.equal((await send(mixed)).status,200);
  assert.equal(store.state.events.size,1);
  assert.equal(state.legacy,1);
  assert.equal(state.qa,1);
  assert.equal((await send(mixed)).status,200);
  assert.equal(store.state.events.size,1);
  assert.equal((await send({...qa(),entry:[
   {...qa().entry[0],changes:[{field:"messages",value:{messages:[]}}]}
  ]})).status,503);
  assert.equal((await send(qa("PARTNER_REMOVED","+60129999999"))).status,503);
  assert.equal((await send({...qa(),entry:[
   {...qa().entry[0],changes:[{field:"account_update",value:{event:"PARTNER_REMOVED"}}]}
  ]})).status,503);
  assert.equal((await send({...qa(),entry:[{...qa().entry[0],id:"99999999999999"}]})).status,200);
  // An unknown number with the *same* E164 is only quarantined as candidate
  // evidence, not treated as an authorized Meta sender.
  assert.equal(store.state.events.size,2);
  state.ack=false;
  assert.equal((await send(qa("ACCOUNT_RECONNECTED"))).status,503);
  store.state.failWrite=true;
  assert.equal((await send(qa("PARTNER_REMOVED"))).status,503);
 }finally{
  if(relay)await close(relay);
  await close(legacySrv);await close(qaSrv);
 }
});
