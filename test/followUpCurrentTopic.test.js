"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {resolveStaffDiscussedFollowUpTopic,assessFollowUpTopicSafety,staffTopicFeatureEnabled}=
  require("../src/utils/followUpCurrentTopic");
const cfg={
 services:[{name:"骨盆调理"},{name:"脉冲波调理"},{name:"子宫调理"},
  {name:"徒手体态调理"},{name:"产后调理"},
  {name:"3D 小颜术"},{name:"9D 逆龄抗衰"}],
 serviceAliases:[
  {alias:"骨盆",officialService:"骨盆调理"},
  {alias:"骨盆矫正",officialService:"骨盆调理"},
  {alias:"子宫",officialService:"子宫调理"},
  {alias:"产后",officialService:"产后调理"},
  {alias:"体态调整",officialService:"徒手体态调理"},
  {alias:"脉冲",officialService:"脉冲波调理"},
  {alias:"3D",officialService:"3D 小颜术"},
  {alias:"9D",officialService:"9D 逆龄抗衰"}],
 promotions:[{linkedService:"骨盆调理",packages:[{name:"Package A"},{name:"Package B"}]}]
};
const at=(id,role,content,time="2026-11-20T09:00:00Z")=>
 ({id,role,content,created_at:time});
const conversation=[
 at(101,"user","Hi～我对黄金脉冲技术有兴趣"),
 at(102,"user","我的问题是生完后肚子没有瘦下来"),
 at(103,"user","肚子是哪个配套呢"),
 at(104,"user","剖腹产"),
 at(105,"assistant","刚开始会比较建议您选择 Package A 💕 因为包括骨盆矫正、体态调整、子宫草药护理"),
 at(106,"assistant","本月优惠 RM388 ✅骨盆调整 ✅子宫草药护理"),
 at(107,"assistant","一定会有效果和分别☺️何况你现在是产后黄金期修复瘦身"),
 at(108,"user","一次就有效果？")
];
test("staff-recommended pelvic Package A, not a generic postpartum remark, selects service-window follow-up topic",()=>{
 const result=resolveStaffDiscussedFollowUpTopic({
  turns:[...conversation].reverse(),clinicConfig:cfg,lastConfirmedMessageId:101});
 assert.deepEqual(result,{treatment:"骨盆调理",staffMessageId:105,kind:"staff_discussed"});
});
test("newly confirmed treatment or a newer customer-chosen service takes precedence",()=>{
 assert.equal(resolveStaffDiscussedFollowUpTopic({
  turns:[...conversation,at(109,"user","我想了解3D 小颜术")],
  clinicConfig:cfg,lastConfirmedMessageId:101}),null);
 assert.equal(resolveStaffDiscussedFollowUpTopic({
  turns:conversation,clinicConfig:cfg,lastConfirmedMessageId:110}),null);
});
test("a newer staff comparison cancels an earlier pelvic recommendation",()=>{
 assert.equal(resolveStaffDiscussedFollowUpTopic({
   turns:[...conversation,at(109,"assistant","建议比较3D或者9D护理")],
   clinicConfig:cfg,lastConfirmedMessageId:101,
 }),null);
});
test("one original ad enquiry plus unsolicited staff offer cannot change topic",()=>{
 assert.equal(resolveStaffDiscussedFollowUpTopic({
  turns:[at(1,"user","Hi～我对脉冲波有兴趣"),
    at(2,"assistant","建议选择 Package A")],
  clinicConfig:cfg,lastConfirmedMessageId:1}),null);
});
test("a staff multi-treatment menu or unrelated package promotion cannot switch",()=>{
 assert.equal(resolveStaffDiscussedFollowUpTopic({
  turns:[at(1,"user","我想改善肚子"),
   at(2,"assistant","你可以选3D或者9D护理")],clinicConfig:cfg}),null);
 assert.equal(resolveStaffDiscussedFollowUpTopic({
  turns:[at(1,"user","请问在哪里"),
   at(2,"assistant","推荐 Package A")],clinicConfig:cfg}),null);
});
test("feature defaults to off and resolver leaves conversation unchanged",()=>{
 const before=JSON.stringify(conversation);
 assert.equal(staffTopicFeatureEnabled({}),false);
 assert.equal(staffTopicFeatureEnabled({NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED:"true"}),true);
 resolveStaffDiscussedFollowUpTopic({turns:conversation,clinicConfig:cfg});
 assert.equal(JSON.stringify(conversation),before);
});
test("staff topics are used only in follow-up services, not result or marketing logic",()=>{
 const primary=fs.readFileSync(path.join(__dirname,"../src/services/followUpService.js"),"utf8");
 const secondary=fs.readFileSync(path.join(__dirname,"../src/services/whatsappSecondaryFollowUpService.js"),"utf8");
 assert.match(primary,/staffTopicFeatureEnabled/);
 assert.match(secondary,/staffTopicFeatureEnabled/);
 for(const file of ["src/utils/resultMediaTrigger.js","src/utils/resultMediaPacing.js",
  "src/services/whatsappSecondaryMarketingFollowUpService.js",
  "src/utils/conversationPromptContext.js"]){
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname,"..",file),"utf8"),/followUpCurrentTopic/);
 }
});


test("negative staff recommendations in Chinese, English and Malay never pick an older pelvic offer",()=>{
 for(const negative of [
  "现在不建议做骨盆调理", "Package A 不适合你",
  "I would not recommend Package A", "Package A tidak sesuai buat masa ini",
 ]) {
  assert.equal(resolveStaffDiscussedFollowUpTopic({
   turns:[...conversation,at(109,"assistant",negative)],
   clinicConfig:cfg,lastConfirmedMessageId:101,
  }),null,negative);
 }
});
test("a newer customer-confirmed pulse preference cannot be overridden by staff upselling pelvic",()=>{
 const turns=[...conversation.slice(0,4),
  at(105,"user","我想先了解脉冲波调理"),
  at(106,"assistant","我会推荐 Package A")];
 assert.equal(resolveStaffDiscussedFollowUpTopic({turns,clinicConfig:cfg,
  lastConfirmedMessageId:105}),null);
});
test("unrelated staff offers and generic package questions cannot invent treatment interest",()=>{
 assert.equal(resolveStaffDiscussedFollowUpTopic({
  turns:[at(1,"user","脉冲波想了解"),
    at(2,"user","哪个配套呢"),
    at(3,"assistant","推荐 Package A")],clinicConfig:cfg}),null);
 assert.equal(resolveStaffDiscussedFollowUpTopic({
  turns:[at(1,"user","肚子一直瘦不下来"),
    at(2,"assistant","我建议 3D 小颜术")],clinicConfig:cfg}),null);
 assert.equal(resolveStaffDiscussedFollowUpTopic({
  turns:[at(1,"user","肚子是哪个配套"),
    at(2,"assistant","推荐 Package ABC")],clinicConfig:cfg}),null);
});
test("declined later customer service stops staff-led topic selection",()=>{
 assert.equal(resolveStaffDiscussedFollowUpTopic({
  turns:[...conversation,at(109,"user","我不想做骨盆调理")],
  clinicConfig:cfg,lastConfirmedMessageId:101}),null);
});
test("existing primary promotional follow-up still precedes staff-discussion fallback",()=>{
 const primary=fs.readFileSync(path.join(__dirname,"../src/services/followUpService.js"),"utf8");
 assert.match(primary,/if \(stepIndex === 1\) \{\s*const promotionFollowUp = promotionFollowUpForCandidate/);
 assert.doesNotMatch(primary,/if \(stepIndex === 1 && !staffTopic\)/);
 const secondary=fs.readFileSync(path.join(__dirname,
  "../src/services/whatsappSecondaryFollowUpService.js"),"utf8");
 assert.match(secondary,/const confirmedTreatment=candidate\.recovery_no_selection\?null:choice\.treatment/);
 assert.match(secondary,/discussionTreatment:staffTopic\?\.treatment\|\|null/);
});
test("secondary staff discussion captions never call a suggested treatment patient-selected",()=>{
 const {staffDiscussedFollowUpText}=require("../src/services/whatsappSecondaryFollowUpLanguage");
 for(const lang of ["zh","en","ms"]){
  for(const slot of [2,6]){
   const copy=staffDiscussedFollowUpText({slot,language:lang,treatment:"骨盆调理"});
   assert.ok(copy?.includes("骨盆调理"),lang+slot);
   assert.ok(!/你之前想了解骨盆|you asked for|you chose|you selected/iu.test(copy),lang+slot);
  }
 }
});
test("secondary booking nudge requires fresh, bounded evidence and cannot unlock 20h",()=>{
 const service=require("../src/services/whatsappSecondaryFollowUpService");
 assert.equal(service.bookingQuestionNudgeSql("NOW()",{}),"FALSE");
 assert.equal(service.bookingQuestionNudgeSql("NOW()",{
  NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED:"true",
  NEUTRO_FOLLOWUP_STAFF_QUESTION_NUDGE_AFTER:"bad"}),"FALSE");
 const sql=service.bookingQuestionNudgeSql("NOW()",{
  NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED:"true",
  NEUTRO_FOLLOWUP_STAFF_QUESTION_NUDGE_AFTER:"2026-11-21T00:00:00Z"});
 for(const required of ["slot_hours=6","first_reply.staff_question",
  "previous_nudge.slot_hours=2","previous_nudge.status='accepted'",
  "previous_nudge.completed_at < first_reply.at",
  "BETWEEN 8 AND 20","2026-11-21T00:00:00.000Z"]){
  assert.ok(sql.includes(required),required);
 }
 assert.ok(!sql.includes("rule.slot_hours=20"));
 const source=fs.readFileSync(path.join(__dirname,
  "../src/services/whatsappSecondaryFollowUpService.js"),"utf8");
 assert.match(source,/bookingQuestionNudgeSql\('\$4::timestamptz'\)/);
 assert.match(source,/bookingQuestionNudgeSql\('NOW\(\)'\)/);
 assert.match(source,/candidate\.staff_reply && candidate\.staff_question\s*\?\s*gentleStaffQuestionNudge/);
 assert.match(source,/!candidate\.staff_reply && !generalOnly/);
});

test("a signed staff caution cannot silently revert to an older verified treatment",()=>{
 const cases=[
  "现在不建议做脉冲波调理，先评估骨盆",
  "I would not recommend 脉冲波调理 for you",
  "脉冲波调理 tidak sesuai buat masa ini",
 ];
 for(const warning of cases){
  const review=assessFollowUpTopicSafety({
   turns:[at(100,"user","我想了解脉冲波调理"),
    at(101,"user","生完后肚子没有瘦下来"),
    at(102,"assistant",warning),
    at(103,"assistant","建议先了解 Package A")],
   clinicConfig:cfg,originalTreatment:"脉冲波调理",
   lastConfirmedMessageId:100,
  });
  assert.equal(review.unsafe,true,warning);
  assert.match(review.reason,/staff_/);
 }
});
test("unresolved staff menu or customer comparison overrides old follow-up fallback",()=>{
 for(const turns of [
  [at(100,"user","我想做脉冲波调理"),
   at(101,"assistant","可以考虑 3D 小颜术 或 9D 逆龄抗衰")],
  [at(100,"user","我想做脉冲波调理"),
   at(101,"user","3D 小颜术还是9D 逆龄抗衰？")],
 ]){
  const review=assessFollowUpTopicSafety({
   turns,clinicConfig:cfg,originalTreatment:"脉冲波调理",
   lastConfirmedMessageId:100,
  });
  assert.equal(review.unsafe,true,JSON.stringify(turns));
 }
});
test("later verified customer choice clears earlier staff advice without changing consent",()=>{
 const turns=[
  at(100,"assistant","不建议做脉冲波调理"),
  at(101,"user","我想了解骨盆调理"),
  at(102,"assistant","骨盆调理可以先预约评估"),
 ];
 assert.equal(assessFollowUpTopicSafety({
  turns,clinicConfig:cfg,originalTreatment:"骨盆调理",
  lastConfirmedMessageId:101,
 }).unsafe,false);
});
test("postpartum symptom alone is not an unsafe named treatment comparison",()=>{
 const review=assessFollowUpTopicSafety({
  turns:conversation,clinicConfig:cfg,originalTreatment:"脉冲波调理",
  lastConfirmedMessageId:101,
 });
 assert.equal(review.unsafe,false);
});
test("primary follow-ups use neutral text and no images, videos, voice or promotion for unsafe topic",()=>{
 const config=require("../src/config/clinicConfig");
 const primary=require("../src/services/followUpService");
 const props=["businessName","clinicName","businessType","services","serviceAliases","promotions","automatedFollowUp"];
 const prior=Object.fromEntries(props.map(k=>[k,config[k]]));
 const previousFeatureFlag=process.env.NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED;
 try {
  process.env.NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED="true";
  Object.assign(config,{businessName:"Neutro Sense TCM Centre",
   clinicName:"Neutro Sense TCM Centre",businessType:"tcm_clinic",
   services:cfg.services,serviceAliases:cfg.serviceAliases,
   promotions:[],automatedFollowUp:{assessmentFirstPricingEnabled:true}});
  const choice=primary.messageForCandidate({
   message:"Generic check-in",translations:{zh:"Generic check-in"},
   serviceOverrides:[{serviceName:"脉冲波调理",translations:{zh:"脉冲推销"},
     imageUrl:"https://example.com/pulse.png",videoKey:"pulse.mp4"}],
  },{
   channel:"whatsapp",treatment_interest:"脉冲波调理",
   adFollowUpPolicy:{treatment:"脉冲波调理",ambiguous:false},
   followup_topic_turns:[at(101,"user","我对脉冲波调理有兴趣"),
    at(102,"assistant","不建议做脉冲波调理")],
  },"zh",1);
  assert.equal(choice.unsafeFollowUpTopic,true);
  assert.equal(choice.targetedService,null);
  assert.equal(choice.selectedImageUrl,"");
  assert.equal(choice.selectedVideoKey,"");
  assert.equal(choice.selectedVoiceNote,null);
  assert.equal(choice.promotionFollowUp,false);
  assert.match(choice.message,/评估/);
  assert.doesNotMatch(choice.message,/脉冲|RM|这段影片/);
 } finally {
  if(previousFeatureFlag===undefined)delete process.env.NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED;
  else process.env.NEUTRO_FOLLOWUP_STAFF_TOPIC_ENABLED=previousFeatureFlag;
  for(const key of props) {
   if(prior[key]===undefined)delete config[key];
   else config[key]=prior[key];
  }
 }
});
