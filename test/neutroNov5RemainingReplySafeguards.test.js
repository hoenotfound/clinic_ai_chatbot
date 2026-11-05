"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {isSimpleVisitTimingQuestion,safeVisitTimingReply}=require("../src/utils/plainVisitSchedulingReply");
const {categorizeAiReview}=require("../src/utils/aiReviewPolicy");
const {correctUnsupportedBranchReply}=require("../src/utils/verifiedPricingBusinessFacts");
const {detectConversationLanguage}=require("../src/utils/chatLanguage");
const {hasRecentStaffConversation}=require("../src/db/messagesRepo");
const {temporaryStaffConversationSql}=require("../src/utils/temporaryStaffConversation");
test("Nov4 #1939 future visit is administrative, not clinical",()=>{
 assert.equal(isSimpleVisitTimingQuestion("我新年过后去可以吗"),true);
 assert.equal(categorizeAiReview("我新年过后去可以吗","clinical"),"information");
 assert.match(safeVisitTimingReply("zh"),/确认/);
 for(const unsafe of ["我术后新年过后去可以吗","我怀孕新年后去可以吗","脊椎侧弯过年后可以做吗"]){
   assert.equal(isSimpleVisitTimingQuestion(unsafe),false);
   assert.equal(categorizeAiReview(unsafe,"clinical"),"clinical");
 }
});
test("Nov4 #8928 only configured PJ branch; no unsupported multiple branches",()=>{
 const one=[{name:"Petaling Jaya (PJ)",address:"Section 19/1, Petaling Jaya"}];
 const a=correctUnsupportedBranchReply({customerText:"哪里有分行？",reply:"我们有多个分行，你靠近哪里？",branches:one,language:"zh"});
 assert.equal(a.changed,true);
 assert.match(a.reply,/Petaling Jaya/);
 assert.doesNotMatch(a.reply,/多个分行/);
 assert.equal(correctUnsupportedBranchReply({customerText:"哪里有分行？",reply:"我们有多个分行",branches:[...one,{name:"KL",address:"Kuala Lumpur"}]}).changed,false);
 // A factual hallucination is corrected even when the customer did not
 // directly ask for directions. Do not send false branch information.
 assert.equal(correctUnsupportedBranchReply({customerText:"如何护理?",reply:"我们有多个分行",branches:one}).changed,true);
 const comment=correctUnsupportedBranchReply({customerText:"Hi",reply:"你比较靠近哪一区？我帮你看看最方便的分行",branches:one});
 assert.equal(comment.changed,true);
 assert.match(comment.reply,/Petaling Jaya/);
 const source=fs.readFileSync(path.join(__dirname,"../src/services/metaCommentAutomationService.js"),"utf8");
 assert.match(source,/correctUnsupportedBranchReply/);
 assert.match(source,/verifiedPrivateText/);
 assert.match(source,/verifiedPublicText/);
});
test("Malay/Chinese conversation is not switched to English by 'trial price'",()=>{
 assert.equal(detectConversationLanguage(["trial price","我想了解3D小颜术"]),"zh");
 assert.equal(detectConversationLanguage(["First Trial","berapa harga rawatan ini"]),"ms");
 assert.equal(detectConversationLanguage(["English please","我想了解"]),"en");
});
test("recent provider-verified human response blocks next Neutro AI reply without a permanent takeover",async()=>{
 let query="";
 assert.equal(await hasRecentStaffConversation(16,123,async(sql,args)=>{
  query=sql;assert.deepEqual(args,[16,123]);return{rows:[{staff_active:true}]};
 }),true);
 assert.match(query,/staff\.whatsapp_message_id IS NOT NULL/);
 assert.match(query,/previous_customer/);
 assert.match(query,/30 minutes/);
 assert.match(query,/staff\.sent_by_username<>'Follow-up automation'/);
 assert.match(query,/INTERVAL '2 hours'/);
 assert.match(query,/NOT EXISTS\s*\(/);
 assert.equal(await hasRecentStaffConversation("x",123),false);
 const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
 assert.match(server,/messagesRepo\.hasRecentStaffConversation\(contact\.id,savedInbound\.id\)/);
 assert.match(server,/correctUnsupportedBranchReply/);
 assert.match(server,/isSimpleVisitTimingQuestion\(text\)/);
 assert.match(server,/!keywordReason&&!urgentSafety/);
 assert.match(server,/!isExplicitStaffRequest\(text\)/);
 assert.match(server,/!whatsappPolicy\.classifyOptOutText\(text\)/);
});

test("Neutro temporary staff ownership is anchored to a genuine recent customer exchange",()=>{
 const sql=temporaryStaffConversationSql("c","inbound");
 assert.match(sql,/previous_customer/);
 assert.match(sql,/30 minutes/);
 assert.match(sql,/birthday/);
 assert.match(sql,/image\/\%/);
 assert.match(sql,/comfirm/);
 assert.match(sql,/staff\.content/);
 assert.throws(()=>temporaryStaffConversationSql("invalid;sql","inbound"),/Invalid SQL alias/);
 const primary=fs.readFileSync(path.join(__dirname,"../src/db/followUpRepo.js"),"utf8");
 const short=fs.readFileSync(path.join(__dirname,"../src/services/whatsappSecondaryFollowUpService.js"),"utf8");
 const long=fs.readFileSync(path.join(__dirname,"../src/services/whatsappSecondaryMarketingFollowUpService.js"),"utf8");
 assert.match(primary,/temporaryStaffConversationSql\(contactAlias,'latest_inbound'\)/);
 assert.match(short,/temporaryStaffConversationSql\('c','inbound'\)/);
 assert.match(long,/temporaryStaffConversationSql\('c','inbound'\)/);
});
test("single-branch correction preserves independent treatment and booking details",()=>{
 const branches=[{name:"Petaling Jaya",address:"Section 19/1, PJ"}];
 const reply=correctUnsupportedBranchReply({customerText:"3D有做吗",
  reply:"3D 是徒手脸型护理。我们有多个分行，你靠近哪里？可以先安排评估。",
  branches,language:"zh"});
 assert.match(reply.reply,/3D 是徒手脸型护理/);
 assert.match(reply.reply,/可以先安排评估/);
 assert.match(reply.reply,/Section 19\/1/);
 assert.doesNotMatch(reply.reply,/多个分行/);
 const mixed=correctUnsupportedBranchReply({customerText:"First Trial 多少钱",
  reply:"3D First Trial 是 RM488，我们有多个分行，你想去哪家？",
  branches,language:"zh"});
 assert.match(mixed.reply,/RM488/);
 assert.match(mixed.reply,/Petaling Jaya/);
 assert.doesNotMatch(mixed.reply,/多个分行/);
 const area=correctUnsupportedBranchReply({customerText:"Hi",
  reply:"你好！你比较靠近哪一区？我帮你看看最方便的分行安排中医师。",
  branches});
 assert.doesNotMatch(area.reply,/靠近哪一区/);
});


test("false-branch correction keeps verified prices and visit invitations after the false claim",()=>{
 const branches=[{name:"Petaling Jaya",address:"Section 19/1, PJ"}];
 for(const [reply,language] of [
  ["我们有多个分行，3D First Trial 是 RM488，你方便什么时候过来？","zh"],
  ["我们有多个分行 3D First Trial 是 RM488，你方便什么时候过来？","zh"],
  ["We have multiple branches, First Trial is RM488. When can you visit?","en"],
  ["Kami ada beberapa cawangan, harga First Trial RM488, boleh datang Sabtu?","ms"],
 ]){
  const corrected=correctUnsupportedBranchReply({customerText:"First Trial?",reply,branches,language});
  assert.equal(corrected.changed,true,reply);
  assert.match(corrected.reply,/RM488/,reply);
  assert.match(corrected.reply,/Petaling Jaya/,reply);
  assert.doesNotMatch(corrected.reply,/多个分行|multiple branches|beberapa cawangan/iu,reply);
  if(language==="zh")assert.match(corrected.reply,/你方便什么时候过来/,reply);
  if(language==="en")assert.match(corrected.reply,/When can you visit/,reply);
  if(language==="ms")assert.match(corrected.reply,/boleh datang Sabtu/,reply);
 }
 const branchQuestion=correctUnsupportedBranchReply({
  customerText:"3D price?",
  reply:"我们有多个分行，你靠近哪里？3D First Trial 是 RM488。",
  branches,language:"zh",
 });
 assert.match(branchQuestion.reply,/RM488/);
 assert.doesNotMatch(branchQuestion.reply,/靠近哪里|多个分行/);
 const selectQuestion=correctUnsupportedBranchReply({
  customerText:"3D price?",
  reply:"3D First Trial 是 RM488，我们有多个分行，你想去哪家？",
  branches,language:"zh",
 });
 assert.match(selectQuestion.reply,/RM488/);
 assert.doesNotMatch(selectQuestion.reply,/你想去哪家|多个分行/);
 const booking=correctUnsupportedBranchReply({
  customerText:"Hi",
  reply:"我们有多个分行，3D First Trial 是 RM488。可以先安排评估。",
  branches,language:"zh",
 });
 assert.match(booking.reply,/RM488/);
 assert.match(booking.reply,/可以先安排评估/);
 const unchanged=correctUnsupportedBranchReply({
  customerText:"First Trial?",
  reply:"3D First Trial 是 RM488，你方便什么时候过来？",
  branches,language:"zh",
 });
 assert.equal(unchanged.changed,false);
});
