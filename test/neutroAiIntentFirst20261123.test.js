"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const {resolveRepeatVisitPriceReply}=require("../src/utils/repeatVisitPriceReply");
const {parseAiReplyResult}=require("../src/utils/aiReplyResult");
const {classifyVerifiedTreatmentTurn,isStoppedDecision}=
  require("../src/services/whatsappSecondaryFollowUpDecision");
const {createPersonalized20h}=require("../src/services/whatsappSecondaryPersonalizedFollowUp");

const services=[{name:"3D 小颜术"},{name:"9D 逆龄抗衰"}];
const aliases=[{alias:"3D小颜术",officialService:"3D 小颜术"}];
const now=Date.now();
const turn=(role,content,offset)=>({role,content,pricingCreatedAtMs:now-120000+offset*1000});
function pricingConversation(text){
 return [
  turn("user","我想了解3D 小颜术",0),
  turn("assistant","3D 小颜术 First Trial 目前是 RM388，首次体验优惠",10),
  turn("user",text,35),
 ];
}
function priceRoute(text,stage,conversationHistory=pricingConversation(text)){
 return resolveRepeatVisitPriceReply({
  customerText:text,conversationHistory,services,serviceAliases:aliases,
  modelPricingStage:stage,language:"zh",now,allowDirectNamedService:true,
 });
}

test("model recognizes natural after-trial pricing wording while CRM/ad cannot authorize a price",()=>{
 for(const text of ["第一次体验后又是什么价格？","接下来的价格又是多少？"]){
  assert.equal(priceRoute(text,null),null,"old exact-word handler misses this expression");
  const outcome=priceRoute(text,"subsequent_session");
  assert.equal(outcome?.treatment,"3D 小颜术",text);
  assert.match(outcome.reply,/第二次|后续|續做/u);
  assert.doesNotMatch(outcome.reply,/RM\s*(388|488|888)/u);
 }
});

test("model metadata cannot create repeat price without a current price question, verified service or trusted history",()=>{
 for(const text of ["3D 我考虑一下","3D 的护理原理是什么","我想预约3D"]){
  assert.equal(priceRoute(text,"subsequent_session"),null,text);
 }
 assert.equal(priceRoute("第一次体验后又是什么价格？","subsequent_session",[
  turn("assistant","3D First Trial RM388",10),
  turn("user","第一次体验后又是什么价格？",35),
 ]),null,"ad or bot mention alone is not customer-selected treatment");
 assert.equal(priceRoute("第一次体验后又是什么价格？","subsequent_session",[
  turn("user","3D 小颜术",0),
  {...turn("assistant","[Verified STAFF message] First Trial RM388",10),pricingStaffAuthored:true},
  turn("user","第一次体验后又是什么价格？",35),
 ]),null,"staff-owned conversation must not be overridden");
});

test("returning customer treatment choice can be older than a day only with a fresh verified trial quote",()=>{
 const old=now-36*3600_000;
 const text="第一次体验后又是什么价格？";
 const history=[
  {role:"user",content:"想了解3D 小颜术",pricingCreatedAtMs:old},
  {role:"assistant",content:"3D 小颜术是脸部轮廓护理",pricingCreatedAtMs:old+1000},
  {role:"user",content:"价格",pricingCreatedAtMs:now-120000},
  {role:"assistant",content:"3D 小颜术 First Trial 体验优惠价是 RM388",pricingCreatedAtMs:now-115000},
  {role:"user",content:text,pricingCreatedAtMs:now-1000},
 ];
 assert.equal(priceRoute(text,"subsequent_session",history)?.treatment,"3D 小颜术");
 const stale=history.map(turn=>({...turn}));
 stale[3].pricingCreatedAtMs=now-24*3600_000;
 assert.equal(priceRoute(text,"subsequent_session",stale),null,"stale trial quote does not justify repeat session");
 const unverified=history.map(turn=>({...turn}));
 unverified[3].content="3D 小颜术价格是 RM388";
 assert.equal(priceRoute(text,"subsequent_session",unverified),null,"ordinary amount without trial proof");
 const staff=history.map(turn=>({...turn}));
 staff[3].pricingStaffAuthored=true;
 assert.equal(priceRoute(text,"subsequent_session",staff),null,"staff-authored price messages do not transfer AI ownership");
});

test("structured AI price-stage classification is optional and validated",()=>{
 const base={reply:"我帮你确认续做价格 😊",outcome:"normal",priceQuery:true,
   packageQuery:false,serviceQuery:false,treatment:null,branch:null,
   appointmentPreference:null};
 assert.equal(parseAiReplyResult(JSON.stringify({...base,pricingStage:"subsequent_session"})).pricingStage,"subsequent_session");
 assert.equal(parseAiReplyResult(JSON.stringify({...base,pricingStage:"first_trial"})).pricingStage,"first_trial");
 assert.equal(parseAiReplyResult(JSON.stringify({...base,pricingStage:"unknown"})).pricingStage,undefined);
 assert.equal(parseAiReplyResult(JSON.stringify(base)).pricingStage,undefined);
});

const config={
 services:[{name:"骨盆调理"},{name:"3D 小颜术"}],
 serviceAliases:[{alias:"骨盆",officialService:"骨盆调理"}],
};
test("verified secondary deferrals persist and protect later reminders",()=>{
 for(const text of [
  "ok谢谢，有需要再预约","我考虑考虑","我在JB的",
  "哦，不好意思，谢谢你 我在JB的",
  "没事哦，我先解决痛的问题之后再来调整骨盆Ok吗？",
 ]){
  const decision=classifyVerifiedTreatmentTurn({text,clinicConfig:config});
  assert.equal(decision?.status,"deferred",text);
  assert.equal(isStoppedDecision(decision.status),true,text);
 }
 for(const text of ["我在JB的，你们有分行吗？","我考虑一下，但是价格多少？",
  "Can I book tomorrow?", "第一次体验后又是什么价格？"]){
  assert.notEqual(classifyVerifiedTreatmentTurn({text,clinicConfig:config})?.status,"deferred",text);
 }
});

const env={
 WHATSAPP_SECONDARY_EARLY_AI_FOLLOWUPS_ENABLED:"true",
 WHATSAPP_SECONDARY_20H_AI_PERSONALIZATION_ENABLED:"true",
 WHATSAPP_SECONDARY_SENDER_KEY:"neutro_secondary",
 WHATSAPP_SECONDARY_PHONE_NUMBER_ID:"sample-phone",
 WHATSAPP_SECONDARY_WABA_ID:"sample-waba",
};
const candidate=slot=>({slot_hours:slot,contact_id:22,conversation_id:44,
 sender_id:5,inbound_id:100});
const database={query:async()=>({rows:[
 {id:100,role:"user",content:"了解骨盆调理",lead:{id:50,treatment_interest:"骨盆调理",
 appointment_status:"none"}},
 {id:99,role:"assistant",content:"可以了解骨盆调理",lead:null},
]})};

test("secondary 2h and 6h use existing AI follow-up decision with bounded sender-scoped history",async()=>{
 for(const [slot,step] of [[2,1],[6,2]]){
  const result=await createPersonalized20h({
   candidate:candidate(slot),database,env,
   generate:async options=>{
    assert.equal(options.stepNumber,step);
    assert.equal(options.contactId,22);
    assert.match(options.instruction,/No prices/);
    return {action:"send",message:"我可以进一步说明骨盆调理的流程，方便您了解自己的需求 😊"};
   },
  });
  assert.equal(result.ok,true);
  assert.equal(result.mode,"ai_personalized");
 }
});

test("AI decides skip/stop/review without falling back to generic sales copy",async()=>{
 for(const slot of [2,6,20]){
  for(const action of ["skip","stop_sequence","human_review"]){
   const decision=await createPersonalized20h({
    candidate:candidate(slot),database,env,
    generate:async()=>({action,message:"",reason:"Customer will book later"}),
   });
   assert.equal(decision.ok,false);
   assert.equal(decision.action,action);
  }
 }
});

test("production paths preserve sender/price/media authority and primary deferral gate",()=>{
 const server=fs.readFileSync(require.resolve("../src/server.js"),"utf8");
 const secondary=fs.readFileSync(require.resolve("../src/services/whatsappSecondaryFollowUpService.js"),"utf8");
 const primary=fs.readFileSync(require.resolve("../src/db/followUpRepo.js"),"utf8");
 assert.match(server,/modelPricingStage = parsedReply\.pricingStage/);
 assert.match(server,/modelPricingStage,/);
 assert.match(server,/subsequent_session_text_only/);
 assert.match(secondary,/personalized\?\.action/);
 assert.match(secondary,/WHATSAPP_SECONDARY_EARLY_AI_FOLLOWUPS_ENABLED/);
 assert.match(primary,/有需要\.\{0,12\}再/);
});
