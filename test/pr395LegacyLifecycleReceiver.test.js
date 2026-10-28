"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const http=require("node:http");
const {enabled,inspectBatch,recordBatch}=require("../src/services/pr395LegacyLifecycleReceiver");
const {configFromEnv,createRelayServer}=require("../src/services/whatsappAppDefaultRelay");
const SECRET="pr395-only-synthetic-meta-secret-for-tests";
const LEGACY="1593376338308612",PHONE="+601130535053";
const QA="+60120000000";
const configEnv={
 WHATSAPP_DEFAULT_RELAY_BOOTSTRAP_MODE:"true",
 WHATSAPP_DEFAULT_RELAY_APP_SECRET:SECRET,
 WHATSAPP_DEFAULT_RELAY_VERIFY_TOKEN:"never-a-real-verify-token",
 WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:LEGACY,
 WHATSAPP_DEFAULT_RELAY_SECONDARY_PHONE_E164:QA,
 WHATSAPP_DEFAULT_RELAY_LEGACY_URL:"https://old.example.invalid/webhook",
 WHATSAPP_DEFAULT_RELAY_LEGACY_LIFECYCLE_URL:"https://audit.example.invalid/pr395-legacy-lifecycle-webhook",
 WHATSAPP_DEFAULT_RELAY_PREIDENTITY_URL:"https://qa.example.invalid/pr395-preidentity-webhook",
};
function env(overrides={}){
 return{
  PR395_STAGING_MODE:"true",
  PR395_STAGING_LEGACY_LIFECYCLE_ENABLED:"true",
  WHATSAPP_SECONDARY_SENDER_KEY:"coexistence_qa",
  PR395_STAGING_APPROVED_TEST_PHONE_E164:QA,
  PR395_STAGING_LEGACY_WABA_ID:LEGACY,
  PR395_STAGING_LEGACY_PHONE_E164:PHONE,
  WHATSAPP_APP_SECRET:SECRET,META_APP_SECRET:SECRET,
  ...overrides,
 };
}
function change(field="account_update",event="PARTNER_REMOVED",phone=PHONE){
 return{field,value:{event,...(phone===null?{}:{phone_number:phone}),
  disconnection_info:{reason:"synthetic-do-not-save"}}};
}
function payload(field="account_update",event="PARTNER_REMOVED",phone=PHONE,account=LEGACY){
 return{object:"whatsapp_business_account",entry:[{
  id:account,time:1800000000,changes:[change(field,event,phone)]
 }]};
}
function store(){
 const state={rows:new Map(),commits:0,rollbacks:0,fail:false};
 const database={connect:async()=>({
  async query(sql,args=[]){
   if(sql==="BEGIN")return{rowCount:0};
   if(sql==="COMMIT"){state.commits++;return{rowCount:0}};
   if(sql==="ROLLBACK"){state.rollbacks++;return{rowCount:0}};
   if(sql.includes("INSERT INTO whatsapp_pr395_legacy_lifecycle_alerts"))return{rowCount:1};
   if(!sql.includes("INSERT INTO whatsapp_legacy_lifecycle_relay_audit"))
     throw Error("Unexpected SQL");
   if(state.fail)throw Error("Simulated database unavailable");
   if(state.rows.has(args[0]))return{rowCount:0};
   state.rows.set(args[0],args);
   return{rowCount:1};
  },release(){}
 })};
 return{database,state};
}
function sig(buf){return"sha256="+crypto.createHmac("sha256",SECRET).update(buf).digest("hex");}
async function listen(server){
 await new Promise((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve)});
 return"http://127.0.0.1:"+server.address().port;
}
async function close(server){if(server.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}}
test("known legacy account_update requires exact account and known phone when present",async()=>{
 const db=store(),setting=env();
 assert.equal(enabled(setting),true);
 const events=inspectBatch(payload(),setting);
 assert.equal(events.length,1);
 assert.equal(events[0].account,LEGACY);
 assert.equal(events[0].phone,PHONE);
 assert.equal((await recordBatch(payload(),{database:db.database,env:setting})).inserted,1);
 assert.equal((await recordBatch(payload(),{database:db.database,env:setting})).inserted,0);
 assert.equal(db.state.rows.size,1);
 assert.equal(db.state.commits,2);
 assert.equal(JSON.stringify([...db.state.rows.values()]).includes("disconnection_info"),false);
 assert.equal((await recordBatch(payload("account_update","ACCOUNT_OFFBOARDED",null),{database:db.database,env:setting})).inserted,1);
 for(const bad of [
  payload("account_update","PARTNER_REMOVED","+60129998888"),
  payload("account_update","PARTNER_REMOVED",PHONE,"999999999"),
  payload("messages"),
  payload("account_update","not-an-event"),
  {...payload(),entry:[...payload().entry,...payload("account_update","PARTNER_REMOVED",PHONE,"999999999").entry]}
 ])await assert.rejects(recordBatch(bad,{database:db.database,env:setting}));
 assert.equal(db.state.rows.size,2);
 for(const override of [
  {PR395_STAGING_MODE:"false"},{PR395_STAGING_LEGACY_LIFECYCLE_ENABLED:"false"},
  {PR395_STAGING_LEGACY_WABA_ID:""},{PR395_STAGING_LEGACY_PHONE_E164:QA},
  {WHATSAPP_APP_SECRET:"wrong"},{WHATSAPP_SECONDARY_WABA_ID:"33333333"},
  {WHATSAPP_SECONDARY_SENDER_KEY:"wrong"},
 ])assert.equal(enabled(env(override)),false);
 db.state.fail=true;
 await assert.rejects(recordBatch(payload("account_update","ACCOUNT_RECONNECTED",null),{
  database:db.database,env:setting
 }),/Simulated database unavailable/);
 assert.equal(db.state.rollbacks,1);
});
test("real local signed relay HTTP requires a COMMIT-bound legacy audit ACK, never bare legacy 200",async()=>{
 const db=store(),state={old:0,audit:0,qa:0,ack:true,failOld:false};
 const setting=env();
 const old=http.createServer(async(req,res)=>{
  const parts=[];for await(const chunk of req)parts.push(chunk);
  const buf=Buffer.concat(parts);
  if(req.url!=="/webhook"||req.headers["x-hub-signature-256"]!==sig(buf))return res.writeHead(403).end();
  const event=JSON.parse(buf);
  if(event.entry.some(x=>x.changes.some(c=>c.field==="account_update")))
    return res.writeHead(500).end("lifecycle may not reach old");
  state.old++;res.writeHead(state.failOld?503:200).end();
 });
 const audit=http.createServer(async(req,res)=>{
  const parts=[];for await(const chunk of req)parts.push(chunk);
  const buf=Buffer.concat(parts);
  if(req.url!=="/pr395-legacy-lifecycle-webhook"||
     req.headers["x-hub-signature-256"]!==sig(buf))return res.writeHead(403).end();
  try{
   await recordBatch(JSON.parse(buf),{database:db.database,env:setting});
   state.audit++;
   res.writeHead(200,state.ack?{"x-da-legacy-lifecycle-accepted":"1"}:{}).end();
  }catch(_){res.writeHead(503).end()}
 });
 const qa=http.createServer(async(req,res)=>{
  const parts=[];for await(const chunk of req)parts.push(chunk);
  const buf=Buffer.concat(parts);
  if(req.headers["x-hub-signature-256"]!==sig(buf))return res.writeHead(403).end();
  state.qa++;res.writeHead(200,{"x-da-coexistence-preidentity-accepted":"1"}).end();
 });
 let relay;
 try{
  const oldUrl=await listen(old),auditUrl=await listen(audit),qaUrl=await listen(qa);
  const cfg=configFromEnv(configEnv);
  const mapping=new Map([
   [cfg.legacyUrl,oldUrl+"/webhook"],
   [cfg.bootstrap.legacyLifecycleUrl,auditUrl+"/pr395-legacy-lifecycle-webhook"],
   [cfg.bootstrap.preidentityUrl,qaUrl+"/pr395-preidentity-webhook"]
  ]);
  relay=createRelayServer(cfg,{fetchImpl:(url,options)=>{
   if(!mapping.has(url))throw Error("Network egress not allowlisted");
   return fetch(mapping.get(url),options);
  }});
  const url=await listen(relay);
  const send=async(data,bad=false)=>{
   const buf=Buffer.from(JSON.stringify(data));
   return fetch(url+"/webhook",{method:"POST",headers:{
    "content-type":"application/json","x-hub-signature-256":bad?"sha256=invalid":sig(buf)
   },body:buf});
  };
  assert.equal((await send(payload(),true)).status,403);
  assert.equal(state.old+state.audit+state.qa,0);
  assert.equal((await send(payload())).status,200);
  assert.equal(state.old,0,"account_update cannot reach legacy /webhook");
  assert.equal(state.audit,1);
  assert.equal(db.state.rows.size,1);
  assert.equal((await send(payload())).status,200);
  assert.equal(db.state.rows.size,1);
  state.ack=false;
  assert.equal((await send(payload("account_update","ACCOUNT_RECONNECTED",null))).status,503);
  state.ack=true;db.state.fail=true;
  assert.equal((await send(payload("account_update","ACCOUNT_OFFBOARDED",null))).status,503);
  db.state.fail=false;
  const ordinary=payload("message_template_status_update","APPROVED");
  const combined={object:"whatsapp_business_account",entry:[
   ...ordinary.entry,...payload("account_update","PARTNER_REMOVED").entry,
   ...payload("account_update","PARTNER_REMOVED",QA,"5555555555555").entry
  ]};
  assert.equal((await send(combined)).status,200);
  assert.equal(state.old,1);
  assert.equal(state.qa,1);
  // A 503 caused by a missing ACK can still follow a durable commit.
  // The provider retry must not duplicate either lifecycle fingerprint.
  assert.equal(db.state.rows.size,2);
  state.failOld=true;
  assert.equal((await send(combined)).status,503);
  assert.equal((await send(payload("account_update","PARTNER_REMOVED","+60129999999"))).status,503);
  assert.equal((await send(payload("account_update","PARTNER_REMOVED",PHONE,"99999999999"))).status,503);
  assert.equal((await send(payload("messages","synthetic",PHONE,"99999999999"))).status,503);
 }finally{if(relay)await close(relay);await close(old);await close(audit);await close(qa)}
});
test("bootstrap URL cannot start without independent legacy lifecycle receiver",()=>{
 assert.throws(()=>configFromEnv({...configEnv,WHATSAPP_DEFAULT_RELAY_LEGACY_LIFECYCLE_URL:""}));
 assert.throws(()=>configFromEnv({...configEnv,WHATSAPP_DEFAULT_RELAY_LEGACY_LIFECYCLE_URL:configEnv.WHATSAPP_DEFAULT_RELAY_LEGACY_URL}));
 assert.throws(()=>configFromEnv({...configEnv,WHATSAPP_DEFAULT_RELAY_LEGACY_WABA_IDS:LEGACY+",999999999"}));
});
