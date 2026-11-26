"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const {manualOnlySecondaryAttention}=require("../src/utils/manualOnlySecondaryAttention");
test("important manual-only secondary inquiries flag staff without enabling AI",()=>{
 for(const text of [
  "Any slot this afternoon? I think i hurt my lower back😅",
  "Can I book tomorrow?", "请问可以预约吗？", "我腰痛想问中医师",
  "胸部有结节可以做吗？", "胸有瘤可以做吗？",
  "乳瘤可以做RM68吗？", "我有乳腺癌可以参加 RM68 吗？",
  "I have a breast tumor. Is RM68 care safe?",
 ]) assert.ok(manualOnlySecondaryAttention(text),text);
 assert.equal(manualOnlySecondaryAttention("Any slot this afternoon? I think i hurt my lower back😅").kind,"health");
});
test("ordinary greetings and campaign texts do not trigger manual-only staff alerts",()=>{
 for(const text of ["Hi","ok","thanks dear","👍","I am considering",
  "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊",
 ])assert.equal(manualOnlySecondaryAttention(text),null,text);
});
test("server keeps manual-only contacts out of AI and checks staff before alerting",()=>{
 const s=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
 const start=s.indexOf("if (secondaryInboxOnly && !mediaType && !unsupportedType)");
 const end=s.indexOf("if (unsupportedType)",start);
 const part=s.slice(start,end);
 assert.ok(start>0&&end>start);
 assert.match(part,/manualOnlySecondaryAttention/);
 assert.match(part,/contact\.mode==="ai"/);
 assert.match(part,/setAiReviewAttention/);
 assert.match(part,/hasStaffReplyAfter/);
 assert.match(part,/setAttention/);
 assert.match(part,/return \{ wasFirstMessage, keywordReason \}/);
 assert.doesNotMatch(part,/sendTrackedText|ai\.generate|sendMessage|updateLead/);
});
test("manual-only health questions create durable reviews and never trigger AI sends",()=>{
 const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
 const start=server.indexOf("if (secondaryInboxOnly && !mediaType && !unsupportedType)");
 const end=server.indexOf("if (unsupportedType)",start);
 const block=server.slice(start,end);
 assert.ok(start>0&&end>start);
 assert.match(block,/actionable\.kind==="health"/);
 assert.match(block,/setAiReviewAttention/);
 assert.match(block,/savedInbound\.id/);
 assert.match(block,/hasStaffReplyAfter/);
 assert.doesNotMatch(block,/sendTrackedText|sendMessage|ai\.getReply/);
});

test("production regressions and broader administrative requests surface staff attention",()=>{
 const at=Date.parse("2026-11-25T07:11:49Z");
 const cases=[
  ["你好，谢谢你们的生日祝福 😊 我刚生完宝宝，还在坐月子。想请问，生日优惠里的哪些项目适合产后妈妈？海报上写的「骨盆矫正」是指「产后骨盆矫正」吗？如果是，一般建议产后多久才做呢？","health"],
  ["另外，可以麻烦你帮我查一下之前买的配套吗？想确认还有哪些护理项目、各剩几次。谢谢你！","account"],
  ["Confirm on 5/12?","appointment"],
  ["Can you check how many sessions I have left?","account"],
  ["Boleh semak baki pakej saya?","account"],
  ["5/12","appointment"],
  ["2pm","appointment"],
  ["确认12月5号可以吗","appointment"],
  ["I will be late for my appointment","appointment"],
  ["Can you help me with my receipt?","enquiry"],
  ["请问停车怎么走？","enquiry"],
  ["Can you tell me where to find the voucher?","enquiry"],
  ["你好😊","none"],
  ["Thanks dear","none"],
  ["Stop sending promotions","none"],
  ["👍","none"],
  ["Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊","none"],
 ];
 for(const [text,kind] of cases)assert.equal(manualOnlySecondaryAttention(text,{receivedAt:at})?.kind||"none",kind,text);
});
test("real server manual-only block persists reviews and generic attention without AI sends",async()=>{
 const vm=require("node:vm");
 const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
 const start=server.indexOf("    if (secondaryInboxOnly && !mediaType && !unsupportedType)");
 const end=server.indexOf("    if (unsupportedType)",start);
 const block=server.slice(start,end);
 const run=async(text,{alreadyAnswered=false,needsAttention=false,mode="ai",writeFailure=false}={})=>{
  const calls=[];
  const ctx={
   secondaryInboxOnly:true,mediaType:null,unsupportedType:null,persistingManualAttention:false,
   manualOnlySecondaryAttention,incoming:{text},contact:{id:17,mode,needs_attention:needsAttention},
   savedInbound:{id:94,created_at:"2026-11-25T07:11:49Z"},wasFirstMessage:false,keywordReason:null,
   messagesRepo:{hasStaffReplyAfter:async(...args)=>{calls.push(["check",...args]);return alreadyAnswered;}},
   contactsRepo:{
    setAiReviewAttention:async(...args)=>{calls.push(["review",...args]);if(writeFailure)throw Error("DB unavailable");},
    setAttention:async(...args)=>{calls.push(["attention",...args]);if(writeFailure)throw Error("DB unavailable");return {id:17};},
   },
   console:{log:(value)=>calls.push(["log",value])}
  };
  const result=await vm.runInNewContext("(async()=>{"+block+"})()",ctx);
  return {calls,result};
 };
 for(const [text,category] of [["我刚生完宝宝，还在坐月子，可以做吗？","clinical"],["帮我查一下之前买的配套还剩几次","information"]]){
  const {calls}=await run(text,{needsAttention:true});
  assert.equal(calls[1][0],"review");
  assert.equal(calls[1][4],category);
  assert.equal(calls[1][5].unansweredOnly,true);
  assert.match(calls.at(-1)[1],/reason=ai_audience_excluded/);
  assert.doesNotMatch(calls.at(-1)[1],/宝宝|配套/);
 }
 const confirmation=await run("Confirm on 5/12?");
 assert.equal(confirmation.calls[1][0],"attention");
 assert.equal(confirmation.calls[1][4].unansweredInboundId,94);
 const answered=await run("Confirm on 5/12?",{alreadyAnswered:true});
 assert.equal(answered.calls.length,2);
 assert.match(answered.calls.at(-1)[1],/staff_already_replied/);
 const existing=await run("Confirm on 5/12?",{needsAttention:true});
 assert.equal(existing.calls.length,2);
 assert.match(existing.calls.at(-1)[1],/existing_attention/);
 const human=await run("我刚生完宝宝，还在坐月子，可以做吗？",{mode:"human"});
 assert.equal(human.calls[1][0],"attention");
 await assert.rejects(run("Confirm on 5/12?",{writeFailure:true}),/DB unavailable/);
 assert.match(server,/if \(secondaryInboxOnly && persistingManualAttention && processingJobId\) throw err/);
});
test("staff attention checks original inbound and preserves existing flags in SQL",()=>{
 const s=fs.readFileSync(path.join(__dirname,"../src/db/contactsRepo.js"),"utf8");
 const start=s.indexOf("async function setAttention(");
 const end=s.indexOf("// Explicit Inbox dismissal",start);
 const part=s.slice(start,end);
 assert.match(part,/unansweredInboundId/);
 assert.match(part,/c\.needs_attention IS NOT TRUE/);
 assert.match(part,/inbound\.id=\$4 AND inbound\.contact_id=c\.id AND inbound\.role='user'/);
 assert.match(part,/unansweredOnly/);
 assert.match(part,/inbound\.id=\$2 AND inbound\.contact_id=c\.id AND inbound\.role='user'/);
 assert.match(part,/staff\.sent_by_username IS NOT NULL/);
 assert.match(part,/\(staff\.created_at,staff\.id\)>\(inbound\.created_at,inbound\.id\)/);
});
