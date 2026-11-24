"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {runOnce,CLAIM_SQL}=require("../src/services/whatsapp131060ContinuationQueue");
const {recoveryTreatmentGroups}=require("../src/services/whatsapp131060Recovery");
const earlier=new Date(Date.now()-60000).toISOString();
const env={
 WHATSAPP_SECONDARY_131060_RECOVERY_ENABLED:"true",
 WHATSAPP_SECONDARY_131060_RECOVERY_ACTIVATED_AT:earlier,
 WHATSAPP_SECONDARY_AI_REPLY_AUDIENCE:"all_contacts",
 WHATSAPP_SECONDARY_AI_REPLY_ALL_ACTIVATED_AT:earlier,
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_PAID_SECONDARY_AUTOMATION_MODE_ENABLED:"true",
 WHATSAPP_SECONDARY_AI_SEND_ENABLED:"true",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
 WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
};
function fixture({result={success:true,wamid:"wamid.second"},allowed=true,canRemove=true,ready=true,interrupt=false}={}){
 const calls={send:0,reserve:0,attention:0,removed:0,status:[],evidence:[],check:0};
 let state="pending",eligible=allowed;
 const job={first_message_id:35,inbound_message_id:34,contact_id:10,buttons:recoveryTreatmentGroups()[1]};
 const database={async query(sql,args){
   if(sql===CLAIM_SQL){
     if(!ready || state!=="pending")return {rows:[]};
     state="claimed";return {rows:[job]};
   }
   if(sql.includes("SET state=$2")){state=args[1];return {rows:[]};}
   if(sql.includes("SET state='pending'")){state="pending";return {rows:[]};}
   if(sql.includes("SELECT 1 FROM whatsapp_131060_continuations"))return {rows:state==="claimed"?[{ok:1}]:[]};
   if(sql.includes("SET second_message_id=$2"))return {rows:[{first_message_id:35}]};
   if(sql.includes("SELECT MIN"))return {rows:[{due:state==="pending"?new Date(Date.now()+5000):null}]};
   return {rows:[]};
 }};
 const deps={database,env,
   eligible:async()=>{calls.check++;return eligible;},
   contacts:{getContactById:async()=>({id:10,channel:"whatsapp",whatsapp_number:"60121100077",whatsapp_sender_key:"neutro_secondary"}),
     setDeliveryAttention:async()=>{calls.attention++;}},
   reserve:async()=>{calls.reserve++;return {id:36};},
   cancel:async()=>{calls.removed++;return canRemove?{id:36}:null;},
   send:async(input)=>{
     calls.send++;
     if(interrupt)eligible=false;
     if(!await input.preSendCheck())return {success:false,cancelled:true,preProviderCancelled:true,noReservation:true};
     return result;
   },
   messages:{setWhatsappMessageId:async(id,wamid)=>calls.status.push([id,wamid]),setDeliveryStatusById:async(id,status)=>calls.status.push([id,status])},
   evidence:{recordOutcome:async(entry)=>calls.evidence.push(entry)}
 };
 return {deps,calls,get state(){return state;}};
}
test("delayed gate leaves the second message pending without creating an outbound row",async()=>{
 const f=fixture({ready:false});
 assert.ok(await runOnce(f.deps)>0);
 assert.equal(f.state,"pending");assert.equal(f.calls.reserve,0);assert.equal(f.calls.send,0);
});
test("new customer or staff turn cancels the continuation without optional failure attention",async()=>{
 for(const opts of [{allowed:false},{interrupt:true}]){
  const f=fixture(opts);await runOnce(f.deps);
  assert.equal(f.state,"cancelled");assert.equal(f.calls.attention,0);
  assert.equal(f.calls.evidence.length,0);
 }
});
test("only a proven pre-reservation billing wait can be deferred",async()=>{
 const f=fixture({result:{success:false,code:"secondary_billing_previous_send_unresolved",noReservation:true,preProviderCancelled:true}});
 await runOnce(f.deps);assert.equal(f.state,"pending");assert.equal(f.calls.removed,1);
 assert.equal(f.calls.attention,0);assert.equal(f.calls.evidence.length,0);
 const held=fixture({result:{success:false,code:"secondary_billing_previous_send_unresolved",ambiguous:true,unknown:true}});
 await runOnce(held.deps);await runOnce(held.deps);
 assert.equal(held.state,"unknown");assert.equal(held.calls.send,1);assert.equal(held.calls.attention,1);
});
test("definite optional failure does not interrupt later AI conversations",async()=>{
 const f=fixture({result:{success:false,code:"secondary_provider_definitively_rejected"}});
 await runOnce(f.deps);await runOnce(f.deps);
 assert.equal(f.state,"failed");assert.equal(f.calls.send,1);assert.equal(f.calls.attention,0);
 assert.deepEqual(f.calls.status,[[36,"failed"]]);
});
test("accepted continuation stays one-shot and no idle polling remains",async()=>{
 const f=fixture();assert.equal(await runOnce(f.deps),null);
 assert.equal(await runOnce(f.deps),null);assert.equal(f.calls.send,1);assert.equal(f.state,"sent");
 assert.equal(f.calls.evidence[0].accepted,true);
});
