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
  "胸部有结节可以做吗？",
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
 assert.match(part,/!contact\.needs_attention/);
 assert.match(part,/hasStaffReplyAfter/);
 assert.match(part,/setAttention/);
 assert.match(part,/return \{ wasFirstMessage, keywordReason \}/);
 assert.doesNotMatch(part,/sendTrackedText|ai\.generate|sendMessage|updateLead/);
});