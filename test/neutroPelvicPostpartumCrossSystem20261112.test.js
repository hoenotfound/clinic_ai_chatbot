"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyVerifiedTreatmentTurn, chooseSecondaryFollowUpTreatment,
  latestMarketingIntentMatches } = require("../src/services/whatsappSecondaryFollowUpDecision");
const { resolveFollowUpTreatment, isBarePostpartumConcernAnswer } =
  require("../src/services/whatsappSecondaryFollowUpLanguage");
const { RECONCILE_CRM_SQL } = require("../src/db/whatsappSecondaryFollowUpTreatmentRepo");
const { sameManuallyUploadedPromotionCaption } =
  require("../src/utils/promotionManualMediaIdentity");
const { wasMediaRecentlySentWithExecutor } = require("../src/db/messagesRepo");
const { selectPromoDuplicateCheck } = require("../src/utils/pricePromotionTrigger");

const config = {
 services: [
   { name: "骨盆调理" },{ name: "产后调理" },
   { name: "3D 小颜术" },{ name: "9D 逆龄抗衰" },
 ],
 serviceAliases: [
   { alias: "骨盆", officialService: "骨盆调理" },
   { alias: "产后", officialService: "产后调理" },
 ],
};
test("a one-word postpartum answer is never recorded as an independent paid-treatment selection",()=>{
 for(const text of ["产后", "產後", "产后体态", "产后  ", "产后的身材"]) {
  assert.equal(isBarePostpartumConcernAnswer(text),true,text);
  assert.equal(classifyVerifiedTreatmentTurn({text,clinicConfig:config}),null,text);
  assert.equal(resolveFollowUpTreatment({clinicConfig:config,customerTexts:[text]}),null,text);
 }
 assert.deepEqual(classifyVerifiedTreatmentTurn({
  text:"我想了解产后调理",clinicConfig:config
 }),{status:"selected",treatment:"产后调理"});
 assert.deepEqual(classifyVerifiedTreatmentTurn({
  text:"我想了解骨盆调理",clinicConfig:config
 }),{status:"selected",treatment:"骨盆调理"});
});
test("signed pelvic choice stays the 2h/6h/20h choice after a bare postpartum concern",()=>{
 const candidate={verified_treatment_status:"selected",
  verified_treatment_name:"骨盆调理",treatment_interest:null,
  customer_texts:["产后","骨盆调理"]};
 assert.deepEqual(chooseSecondaryFollowUpTreatment({candidate,clinicConfig:config}),
  {treatment:"骨盆调理",customerSelected:true,generalOnly:false});
 assert.equal(latestMarketingIntentMatches({customerMessages:["产后"],
  treatmentInterest:"骨盆调理",clinicConfig:config}),true);
 // A bare concern should NOT turn an unrelated ad/CRM 3D choice into a
 // new verified postpartum treatment, or release an unrelated marketing ad.
 assert.equal(chooseSecondaryFollowUpTreatment({
  candidate:{...candidate,verified_treatment_name:"3D 小颜术"},
  clinicConfig:config,
 }).generalOnly,true);
 assert.equal(latestMarketingIntentMatches({customerMessages:["产后"],
  treatmentInterest:"3D 小颜术",clinicConfig:config}),false);
});
test("only automation-owned, open, unassigned, signed and unedited unattributed leads may reconcile CRM",()=>{
 assert.match(RECONCILE_CRM_SQL,/l.source IN \('meta_ads','whatsapp_unattributed'\)/);
 for(const required of [
  /l.created_by='Automation'/,
  /state.status='selected'/,
  /msg.whatsapp_message_id IS NOT NULL/,
  /msg.source_created_at IS NOT NULL/,
  /sc.state='bound'/,
  /l.owner_username IS NULL/,
  /NOT EXISTS \([\s\S]*?FROM lead_activities human_activity/,
  /l.is_closed IS DISTINCT FROM TRUE/,
 ]) assert.match(RECONCILE_CRM_SQL,required);
 assert.doesNotMatch(RECONCILE_CRM_SQL,/marketing_consent\s*=/);
});
const expectedA = "本月限时优惠 🔥\nRM100 优惠券限时领取（只限100位）\n原价 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣\n\n尊享护理配套｜2小时30分钟\n包含：\n\n✅骨盆调整与体态矫正疗程\n✅经络穴位按摩\n✅子宫草药护理\n✅AI 身体检测";
const staffA = "本月限时优惠 🔥\r\nRM100 优惠券限时领取（只限100位）\r\n原价优惠 RM488\r\n优惠后仅需 RM3️⃣8️⃣8️⃣\r\n\r\n尊享护理配套｜2小时30分钟\r\n包含：\r\n\r\n✅骨盆调整与体态矫正疗程\r\n✅经络穴位按摩\r\n✅子宫草药护理\r\n✅AI 身体检测";
const expectedB = "本月限时优惠 🔥 RM100 优惠券\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣\n\n1小时30分钟女性护理配套\n\n✅骨盆调整与体态矫正疗程\n✅子宫护理\n✅艾灸桶护理｜排湿・驱寒\n\n限时礼遇 · 预约专享";
test("strongly matching manual promo captions suppress duplicates, not other packages or edited prices",()=>{
 assert.equal(sameManuallyUploadedPromotionCaption(expectedA,staffA),true);
 assert.equal(sameManuallyUploadedPromotionCaption(expectedB,expectedB.replace(/\n/g,"\r\n")),true);
 assert.equal(sameManuallyUploadedPromotionCaption(expectedA,expectedB),false);
 assert.equal(sameManuallyUploadedPromotionCaption(expectedA,staffA.replace("RM488","RM688")),false);
 assert.equal(sameManuallyUploadedPromotionCaption("RM388 only","RM388 only"),false);
 assert.equal(sameManuallyUploadedPromotionCaption(expectedA,"Random staff photo"),false);
});
test("verified duplicate selector checks manual uploads as well as original URLs",async()=>{
 const calls=[];
 const executor={query:async(sql,args)=>{
  calls.push({sql,args});
  if(calls.length===1)return {rowCount:0,rows:[]};
  return {rowCount:1,rows:[{content:staffA}]};
 }};
 assert.equal(await wasMediaRecentlySentWithExecutor(executor,1,
  "https://example.test/promo-images/30",24,expectedA),true);
 assert.equal(calls.length,2);
 assert.match(calls[1].sql,/sent_by_username IS NOT NULL/);
 assert.match(calls[1].sql,/media_key IS NOT NULL/);
 assert.match(calls[1].sql,/whatsapp_message_id IS NOT NULL/);
 assert.match(calls[1].sql,/delivery_status NOT IN/);
 assert.deepEqual(calls[1].args,[1,24]);
 const stub={wasPromoRecentlySent:async()=>false,
  wasMediaRecentlySent:async(...args)=>{assert.deepEqual(args,
   [1,"https://example.test/promo-images/30",24,expectedA]);return true;}};
 const check=selectPromoDuplicateCheck({aiPricingEnabled:true,messagesRepo:stub});
 assert.equal(await check(1,"https://example.test/promo-images/30",expectedA,24),true);
});
test("nonmatching manual images never suppress a new legitimate promo",async()=>{
 const executor={query:async(sql)=>sql.includes("SELECT content FROM messages")
  ? {rowCount:1,rows:[{content:expectedB}]}
  : {rowCount:0,rows:[]}};
 assert.equal(await wasMediaRecentlySentWithExecutor(executor,1,
  "/promo-images/30",24,expectedA),false);
});
