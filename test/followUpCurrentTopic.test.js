"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {resolveStaffDiscussedFollowUpTopic,staffTopicFeatureEnabled}=
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
