"use strict";
// Signed HTTP receiver rehearsal. Loopback only, synthetic customer content,
// no external Meta call and no production database.
const test=require("node:test"),assert=require("node:assert/strict");
const crypto=require("node:crypto");
const readiness=require("../src/services/startupReadinessService");
const {createApp}=require("../src/createApp");
const secret="synthetic-paid-early-history-meta-secret-20261029";
const base={
 NODE_ENV:"test",PR395_STAGING_MODE:"false",
 WHATSAPP_APP_SECRET:secret,META_APP_SECRET:secret,
 WHATSAPP_PAID_DEFAULT_ROUTER_ENABLED:"true",
 WHATSAPP_PAID_DEFAULT_VERIFY_TOKEN:"synthetic-separate-verify-token-20261029",
 WHATSAPP_PAID_DEFAULT_PRIMARY_PHONE_E164:"+601130535053",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OPERATOR_APPROVED:"true",
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_OWNER_CONSENT_VERIFIED:"true",
 WHATSAPP_SECONDARY_PRE_QR_OWNER_APPROVED:"true",
 WHATSAPP_SECONDARY_PRODUCTION_VAULT_ENABLED:"true",
 WHATSAPP_SECONDARY_PRODUCTION_TOKEN_ENCRYPTION_KEY:Buffer.alloc(32,40).toString("base64"),
 WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_UNTIL:new Date(Date.now()+3600000).toISOString(),
 WHATSAPP_PRIMARY_SENDER_KEY:"neutro",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_EXPECTED_PHONE_E164:"+60174831336",
 WHATSAPP_WABA_ID:"1593376338308612",
 WHATSAPP_PHONE_NUMBER_ID:"1408739622311791",
 WHATSAPP_PHONE_NUMBER:"+601130535053",
 WHATSAPP_SINGLE_SENDER_STRICT_METADATA:"true",
 WHATSAPP_SINGLE_SENDER_ACCOUNT_GUARD_ENABLED:"true"
};
function setEnv(t,env){
 const old={};for(const [key,v] of Object.entries(env)){
  old[key]=process.env[key];if(v===undefined)delete process.env[key];else process.env[key]=v;
 }
 t.after(()=>{for(const [key,v] of Object.entries(old)){
  if(v===undefined)delete process.env[key];else process.env[key]=v;
 }readiness.resetForTests();});
}
function body(field="history",display="+60 17-483 1336",id="222222222222222"){
 return JSON.stringify({object:"whatsapp_business_account",entry:[{id,changes:[{
  field,value:{messaging_product:"whatsapp",
   metadata:{phone_number_id:"333333333333333",display_phone_number:display},
   history:[{threads:[{id:"60129990001",messages:[]}]}]
  }
 }]}]});
}
function headers(raw,valid=true){
 return {"Content-Type":"application/json",
  "X-Hub-Signature-256":"sha256="+crypto.createHmac("sha256",valid?secret:"wrong-test-secret").update(raw).digest("hex")};
}
async function withServer(app,fn){
 const server=await new Promise((resolve,reject)=>{
  const s=app.listen(0,"127.0.0.1",()=>resolve(s));
  s.on("error",reject);
 });
 try{return await fn("http://127.0.0.1:"+server.address().port);}
 finally{await new Promise(resolve=>server.close(resolve));}
}
function app(stage){
 return createApp({sessionSecret:"synthetic-session-secret-for-early-http",
  durablyClaimIncoming:async()=>{throw Error("Must not process early history as primary customer message");},
  scheduleDurableClaim:async()=>{},queueIncomingForReply:async()=>{},
  stagePaidEarlyHistory:stage
 });
}
test("full Express signed early history: commit before 200, duplicate delivered safely",async t=>{
 setEnv(t,base);readiness.markReady();
 let hits=0,primary=0;
 await withServer(app(async payload=>{
  hits++;
  assert.equal(payload.entry[0].id,"222222222222222");
  assert.equal(payload.entry[0].changes[0].field,"history");
  return {durable:true,inserted:hits===1?1:0};
 }),async url=>{
  const raw=body();
  for(let i=0;i<2;i++){
   const result=await fetch(url+"/whatsapp/default",{method:"POST",headers:headers(raw),body:raw});
   assert.equal(result.status,200);
  }
  assert.equal(hits,2);assert.equal(primary,0);
 });
});
test("real Express rejects missing HMAC and forged phone/account without ACK",async t=>{
 setEnv(t,base);readiness.markReady();
 let writes=0;
 await withServer(app(async()=>{writes++;return {durable:true,inserted:1};}),async url=>{
  const raw=body();
  for(const h of [{"Content-Type":"application/json"},headers(raw,false)]){
   const resp=await fetch(url+"/whatsapp/default",{method:"POST",headers:h,body:raw});
   assert.equal(resp.status,403);
  }
  for(const wrong of [
   body("history","+60 12-222 4444"),
   body("history","+60 17-483 1336",base.WHATSAPP_WABA_ID),
   body("history","+60 17-483 1336","not-numeric")
  ]){
   const resp=await fetch(url+"/whatsapp/default",{method:"POST",headers:headers(wrong),body:wrong});
   assert.equal(resp.status,503);
  }
  assert.equal(writes,0);
 });
});
test("real Express returns 503 when early hold database is unavailable; no false 200",async t=>{
 setEnv(t,base);readiness.markReady();
 await withServer(app(async()=>{throw Error("synthetic database failure");}),async url=>{
  const raw=body();
  const res=await fetch(url+"/whatsapp/default",{method:"POST",headers:headers(raw),body:raw});
  assert.equal(res.status,503);
 });
});
test("real Express early capture OFF does not accept secondary history",async t=>{
 setEnv(t,{...base,WHATSAPP_PAID_SECONDARY_EARLY_CAPTURE_ENABLED:"false"});
 readiness.markReady();let writes=0;
 await withServer(app(async()=>{writes++;return {durable:true,inserted:1};}),async url=>{
  const raw=body();
  const res=await fetch(url+"/whatsapp/default",{method:"POST",headers:headers(raw),body:raw});
  assert.equal(res.status,503);
  assert.equal(writes,0);
 });
});
