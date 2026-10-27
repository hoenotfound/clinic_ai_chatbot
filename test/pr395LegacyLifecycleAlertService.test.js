"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {enabled,runOnce}=require("../src/services/pr395LegacyLifecycleAlertService");
function env(){
 return{
  PR395_STAGING_MODE:"true",PR395_STAGING_LEGACY_LIFECYCLE_ENABLED:"true",
  PR395_STAGING_LEGACY_LIFECYCLE_ALERT_ENABLED:"true",
  PR395_STAGING_LEGACY_WABA_ID:"1593376338308612",
  TELEGRAM_ALERTS_ENABLED:"true",TELEGRAM_BOT_TOKEN:"test-token",
  TELEGRAM_CHAT_ID:"test-chat"
 };
}
function database(){
 const updates=[],event={
  fingerprint:"a".repeat(64),account_id:"1593376338308612",
  event_type:"PARTNER_REMOVED",severity:"critical"
 };
 return{
  updates,
  async query(sql,params=[]){
   updates.push({sql,params});
   if(sql.includes("RETURNING fingerprint,account_id,event_type,severity"))
    return{rows:[event]};
   return{rowCount:1,rows:[]};
  }
 };
}
test("legacy lifecycle alert cannot run in production or without opt-in and Telegram",async()=>{
 for(const patch of [
  {PR395_STAGING_MODE:"false"},
  {PR395_STAGING_LEGACY_LIFECYCLE_ALERT_ENABLED:"false"},
  {PR395_STAGING_ALLOW_PROVIDER_PROCESSING:"true"},
  {TELEGRAM_BOT_TOKEN:""}
 ]){
  const e={...env(),...patch};assert.equal(enabled(e),false);
  const database={query(){throw Error("must not query")}};
  assert.deepEqual(await runOnce({env:e,database}),{processed:0,disabled:true});
 }
});
test("signed isolated audit leads to a critical Neutro alert without sender-state changes",async()=>{
 const d=database(),messages=[];
 const result=await runOnce({env:env(),database:d,post:async(msg)=>{messages.push(msg)}});
 assert.deepEqual(result,{processed:1,critical:true});
 assert.equal(messages.length,1);
 assert.match(messages[0].text,/PARTNER_REMOVED/);
 assert.match(messages[0].text,/STOP QR/);
 assert.ok(d.updates.every(q=>!q.sql.includes("UPDATE whatsapp_sender_accounts")));
 assert.ok(d.updates.some(q=>q.sql.includes("delivery_state='sent'")));
});
test("Telegram timeout becomes durable uncertain delivery, no silent drop/retry",async()=>{
 const d=database();
 const result=await runOnce({env:env(),database:d,
  post:async()=>{throw Error("simulated timeout")},
  logger:{error(){}}
 });
 assert.equal(result.unknown,true);
 assert.ok(d.updates.some(q=>q.sql.includes("delivery_state='unknown'")));
 assert.ok(d.updates.every(q=>!q.sql.includes("UPDATE whatsapp_sender_accounts")));
});
