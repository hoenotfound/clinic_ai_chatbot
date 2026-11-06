"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {classifyVerifiedTreatmentTurn,isStoppedDecision,chooseSecondaryFollowUpTreatment}=
  require("../src/services/whatsappSecondaryFollowUpDecision");
const repo=require("../src/db/whatsappSecondaryFollowUpTreatmentRepo");
const {resolveFollowUpTreatment}=require("../src/services/whatsappSecondaryFollowUpLanguage");
const config={
 services:[{name:"骨盆调理"},{name:"3D 小颜术"},{name:"9D 逆龄抗衰"},
  {name:"3D + 9D 组合"}],
 serviceAliases:[
  {alias:"骨盆",officialService:"骨盆调理"},
  {alias:"pelvic",officialService:"骨盆调理"},
  {alias:"3D",officialService:"3D 小颜术"},
  {alias:"9D",officialService:"9D 逆龄抗衰"},
  {alias:"3D + 9D",officialService:"3D + 9D 组合"},
 ],
};
test("confirmed pelvic interest is persistable and prices/branch-only messages do not change it",()=>{
 assert.deepEqual(classifyVerifiedTreatmentTurn({
  text:"我对你们的骨盆调理有兴趣，想了解一下。",clinicConfig:config}),
  {status:"selected",treatment:"骨盆调理"});
 for(const text of ["哪一分行","RM388和RM288的配套有什么分别？",
  "在哪里？","Can you confirm the price?"]){
  assert.equal(classifyVerifiedTreatmentTurn({text,clinicConfig:config}),null,text);
 }
});
test("withdrawal without treatment name blocks follow-ups, including later generic reminders",()=>{
 for(const text of ["算了，暂时不要了","暂时不要了","不用了",
   "不考虑了","Not interested","No longer interested","Tak berminat",
   "I don't want pelvic care anymore","不要3D"]){
  const decision=classifyVerifiedTreatmentTurn({text,clinicConfig:config});
  assert.equal(decision?.status,"declined",text);
  assert.equal(isStoppedDecision(decision.status),true);
 }
 for(const text of ["我考虑一下","Let me think","I'll get back to you",
  "我再联系你"]){
  const decision=classifyVerifiedTreatmentTurn({text,clinicConfig:config});
  assert.equal(decision?.status,"deferred",text);
  assert.equal(isStoppedDecision(decision.status),true);
 }
});
test("queries and questions are not wrongly counted as refusals",()=>{
 for(const text of ["我不是很清楚骨盆调理是什么",
  "I don't know how pelvic care works",
  "请问骨盆调理是做一次就可以了吗？"]){
  assert.equal(classifyVerifiedTreatmentTurn({text,clinicConfig:config})?.status,
   "selected",text);
 }
});
test("customer switches treatment only with a new verified named choice",()=>{
 const pelvic=classifyVerifiedTreatmentTurn({
  text:"我想了解骨盆调理",clinicConfig:config});
 const switched=classifyVerifiedTreatmentTurn({
  text:"Now I want 9D instead",clinicConfig:config});
 assert.equal(pelvic.treatment,"骨盆调理");
 assert.equal(switched.treatment,"9D 逆龄抗衰");
 assert.deepEqual(classifyVerifiedTreatmentTurn({
  text:"Should I choose 3D or 9D?",clinicConfig:config}),
  {status:"ambiguous",treatment:null});
 assert.deepEqual(classifyVerifiedTreatmentTurn({
  text:"我不想做3D了",clinicConfig:config}),
  {status:"declined",treatment:null});
 assert.equal(resolveFollowUpTreatment({
  clinicConfig:config,customerTexts:["我想了解骨盆调理"],
  treatmentInterest:switched.treatment}),"骨盆调理",
  "newer actual customer text must beat stale stored interest");
});
test("record only from verified secondary sender and no raw history, consent or staff CRM writes",async()=>{
 const calls=[];
 const db={query:async(sql,args)=>{
  calls.push({sql,args});
  return{rowCount:1,rows:[{}]};
 }};
 assert.equal((await repo.recordFromInbound({
  contactId:8943,messageId:17188,senderKey:"neutro_secondary",
  text:"我想了解骨盆调理",clinicConfig:config},{database:db})).recorded,true);
 assert.deepEqual(calls[0].args,[8943,17188,"neutro_secondary","selected","骨盆调理"]);
 for(const senderKey of ["neutro","unverified"]){
  assert.equal((await repo.recordFromInbound({contactId:8943,messageId:17190,
   senderKey,text:"我想了解骨盆调理",clinicConfig:config},{database:db})).recorded,false);
 }
 assert.equal((await repo.recordFromInbound({contactId:8943,messageId:17192,
   senderKey:"neutro_secondary",text:"你们在哪？",clinicConfig:config},
   {database:db})).recorded,false);
 assert.equal(calls.length,1);
 assert.match(repo.RECORD_SQL,/m.whatsapp_message_id IS NOT NULL/);
 assert.match(repo.RECORD_SQL,/m.source_created_at IS NOT NULL/);
 assert.match(repo.RECORD_SQL,/sc.state='bound'/);
 assert.match(repo.RECORD_SQL,/historical.sender_id=sa.id/);
 assert.match(repo.RECORD_SQL,/source_message_id <\s*EXCLUDED.source_message_id/);
 assert.doesNotMatch(repo.RECORD_SQL,/UPDATE leads|marketing_consent/i);
});
test("SQL refuses stopped contacts at discovery and final provider check",()=>{
 const service=fs.readFileSync(path.join(__dirname,
  "../src/services/whatsappSecondaryFollowUpService.js"),"utf8");
 const marketing=fs.readFileSync(path.join(__dirname,
  "../src/services/whatsappSecondaryMarketingFollowUpService.js"),"utf8");
 assert.match(service,/const SECONDARY_DECISION_HOLD_SQL=/);
 assert.match(service,/declined_state.status IN\('declined','deferred'\)/);
 assert.match(service,/\$\{SECONDARY_DECISION_HOLD_SQL\}/);
 assert.match(marketing,/decision_hold.status IN\('declined','deferred','ambiguous'\)/);
 assert.match(marketing,/LOWER\(BTRIM\(decision_hold\.treatment_name\)\)/);
 assert.match(marketing,/LOWER\(BTRIM\(lead\.treatment_interest\)\)/);
 for(const sql of [service,marketing]){
  assert.match(sql,/explicit_switch\.source_message_id=inbound\.id/);
  assert.match(sql,/explicit_switch\.status='selected'/);
 }
 assert.match(marketing,/whatsapp_sender_followup_treatment_state/);
 const migration=fs.readFileSync(path.join(__dirname,
  "../src/db/migrations/118_whatsapp_secondary_followup_treatment_state.sql"),"utf8");
 assert.match(migration,/PRIMARY KEY \(sender_id, contact_id\)/);
 assert.doesNotMatch(migration,/INSERT INTO whatsapp_sender_followup_treatment_state/i);
});

test("rejecting a price quote is not necessarily rejecting a treatment",()=>{
 assert.equal(classifyVerifiedTreatmentTurn({
  text:"我不想要报价",clinicConfig:config}),null);
 assert.notEqual(classifyVerifiedTreatmentTurn({
  text:"I don't want pricing information, but tell me about pelvic care",clinicConfig:config})?.status,"declined");
});

test("a customer changing 3D to 9D is a selection, not a withdrawal",()=>{
 for(const msg of [
  "我不想做3D了，我想了解9D",
  "I don't want 3D, I'm interested in 9D",
  "I'm not interested in 3D, but 9D looks good",
 ]){
  assert.deepEqual(classifyVerifiedTreatmentTurn({text:msg,clinicConfig:config}),
   {status:"selected",treatment:"9D 逆龄抗衰"},msg);
 }
 for(const msg of ["我不想做3D了","I don't want 3D anymore",
  "I don't want 3D or 9D"]){
  assert.equal(classifyVerifiedTreatmentTurn({text:msg,clinicConfig:config})?.status,
   "declined",msg);
 }
});

test("verified current treatment beats ad creative, old CRM and the last-24h window",()=>{
 const candidate={
  verified_treatment_status:"selected",
  verified_treatment_name:"9D 逆龄抗衰",
  treatment_interest:"3D 小颜术",
  customer_texts:["哪一分行","RM388和RM288有什么不同？"],
 };
 const staleAd={ambiguous:false,treatment:"3D 小颜术",source:"verified_ad_creative"};
 assert.deepEqual(chooseSecondaryFollowUpTreatment({
  candidate,clinicConfig:config,adFollowUpPolicy:staleAd,
 }),{treatment:"9D 逆龄抗衰",generalOnly:false,customerSelected:true});
 assert.deepEqual(chooseSecondaryFollowUpTreatment({
  candidate:{...candidate,verified_treatment_name:"3D 小颜术"},
  clinicConfig:config,adFollowUpPolicy:staleAd,
  latestDecision:{status:"selected",treatment:"9D 逆龄抗衰"},
 }),{treatment:"9D 逆龄抗衰",generalOnly:false,customerSelected:true});
 assert.deepEqual(chooseSecondaryFollowUpTreatment({
  candidate,clinicConfig:config,
  adFollowUpPolicy:{ambiguous:true,treatment:null},
 }),{treatment:"9D 逆龄抗衰",generalOnly:false,customerSelected:true});
});

test("ambiguous choice and removed treatment cannot trigger stale ad videos",()=>{
 const ad={ambiguous:false,treatment:"3D 小颜术"};
 assert.deepEqual(chooseSecondaryFollowUpTreatment({
  candidate:{verified_treatment_status:"ambiguous",customer_texts:["哪一分行"],
   treatment_interest:"3D 小颜术"},
  clinicConfig:config,adFollowUpPolicy:ad,
 }),{treatment:null,generalOnly:true,customerSelected:false});
 assert.deepEqual(chooseSecondaryFollowUpTreatment({
  candidate:{verified_treatment_status:"selected",verified_treatment_name:"Discontinued service"},
  clinicConfig:config,adFollowUpPolicy:ad,
 }),{treatment:null,generalOnly:true,customerSelected:false});
});
