"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const ai=require("../src/services/whatsappSecondaryPersonalizedFollowUp");
const env={
 WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"1318355951360575",
 WHATSAPP_SECONDARY_WABA_ID:"1852014482431209",
};
const candidate={contact_id:22,conversation_id:44,sender_id:5,inbound_id:100,slot_hours:20};
function db({latest=100,rows=null}={}){
 const got=[];
 return{
  got,
  database:{query:async(sql,args)=>{
   got.push({sql,args});
   return{rows:rows||[
    {id:latest,role:"user",content:"想了解骨盆调理",lead:{
      id:50,treatment_interest:"骨盆",appointment_status:"none"}},
    {id:99,role:"assistant",content:"可以安排体态评估了解需求",lead:null},
   ]};
  }},
 };
}
const reply="关于骨盆调理，我们可以安排一对一体态评估和体验，了解您的关注点后再说明合适的调理方向。";
test("20h AI uses only sender-qualified anchor, treatment context, existing generator",async()=>{
 const x=db();
 const result=await ai.createPersonalized20h({env,candidate,database:x.database,
  generate:async payload=>{
   assert.equal(payload.contactId,22);
   assert.equal(payload.triggerMessageId,100);
   assert.equal(payload.treatmentInterest,"骨盆");
   assert.equal(payload.stepNumber,3);
   assert.match(payload.instruction,/No prices/);
   return{action:"send",message:reply};
  }});
 assert.equal(result.ok,true);
 assert.equal(result.message,reply);
 assert.match(x.got[0].sql,/whatsapp_sender_message_context/);
 assert.match(x.got[0].sql,/whatsapp_sender_coexistence_history_messages/);
 assert.deepEqual(x.got[0].args.slice(0,3),[22,44,5]);
 assert.equal(x.got[0].args[3],"neutro_secondary");
});
test("20h AI fails closed on history anchor, later customer message, AI absence, prices and repeated copy",async()=>{
 assert.equal((await ai.createPersonalized20h({
  candidate,env:{},database:db().database})).ok,false);
 assert.equal((await ai.createPersonalized20h({
  candidate,env,database:db({latest:101}).database})).ok,false);
 assert.equal((await ai.createPersonalized20h({
  candidate,env,database:db().database,
  generate:async()=>{throw Error("503")}})).ok,false);
 assert.equal((await ai.createPersonalized20h({
  candidate,env,database:db().database,
  generate:async()=>({action:"skip",message:reply})})).ok,false);
 assert.equal((await ai.createPersonalized20h({
  candidate,env,database:db().database,
  generate:async()=>({action:"send",message:"9D trial RM488 today!"})})).ok,false);
 assert.equal((await ai.createPersonalized20h({
  candidate,env,database:db().database,
  generate:async()=>({action:"send",message:"可以安排体态评估了解需求"})})).ok,false);
});
