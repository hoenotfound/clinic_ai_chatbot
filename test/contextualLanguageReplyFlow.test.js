"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const vm=require("node:vm");
const language=require("../src/utils/chatLanguage");
const guard=require("../src/utils/replyLanguageGuard");
const {fallbackHandoffReply}=require("../src/utils/handoffReply");
const source=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
function section(start,end){
 const a=source.indexOf(start),b=source.indexOf(end,a);
 assert.ok(a>=0 && b>a);
 return source.slice(a,b);
}
const choice=section("    const explicitReplyLanguage =","    const marketingStopQuestion =");
const intro=section("    const continuingLanguageRequest =","    // High-confidence urgent safety phrases");
const final=section("    // Check the text after all transformations.","    // Reopening sales is a positive action:");
const branch=source.match(/else if \((isGreetingOrLanguageOnly\(text\) && detectExplicitLanguagePreference\(text\) &&\s*!replyHistory\.some\(message => message\?\.role === "assistant"\))\) \{/u);
test("shared live-handler language stages retain treatment and suppress late wrong-language media for either sender",async()=>{
 assert.ok(branch);
 for(const sender of ["primary","secondary"]){
  for(const text of ["English Info pls","English please"]){
   const history=[{role:"user",contextMessageId:1,content:"我想了解骨盆调理"},
     {role:"assistant",contextMessageId:2,content:"我们的骨盆调理是徒手体态护理"},
     {role:"user",contextMessageId:3,content:text}];
   const writes=[],reviews=[],audit=[];
   const ctx={...language,...guard,fallbackHandoffReply,console,
     text,history,readableRecoveryHistory:history,replyHistory:history,
     contact:{id:7,whatsapp_sender_key:sender},savedInbound:{id:3},
     contactsRepo:{saveReplyLanguagePreference:async(...args)=>writes.push(args),setAiReviewAttention:async(...args)=>reviews.push(args)},
     clinicConfig:{introMessage:"你好，欢迎来到 Neutro Sense"},
     forceFirstMessage:true,verifiedFirstReadableAd:false,wasFirstMessage:false,
     flagged:false,bookingReady:false,urgentSafety:false,isActiveSafetyConcern:()=>false,
     reply:"我们的骨盆调理是徒手体态护理，请问想改善哪个部位呢？",
     priceQuery:true,packageQuery:true,serviceQuery:true,serviceQuerySource:"conversation",
     reviewContinuationTextOnly:false,replyOverrideAudit:{change:(...args)=>audit.push(args)}};
   const result=await vm.runInNewContext("(async()=>{"+choice+intro+"\nconst canned=Boolean("+branch[1]+");\n"+final+"\nreturn {mediaLanguage,isFirstMessage,generateFirstIntro,canned,reply,priceQuery,packageQuery,serviceQuery,reviewContinuationTextOnly};})()",ctx);
   assert.equal(result.mediaLanguage,"en",sender);
   assert.equal(result.isFirstMessage,false);
   assert.equal(result.generateFirstIntro,false);
   assert.equal(result.canned,false);
   assert.equal(writes.length,1);
   assert.equal(writes[0][2],"en");
   assert.equal(guard.clearReplyLanguageMismatch(result.reply,"en"),false);
   assert.equal(result.priceQuery,false);
   assert.equal(result.packageQuery,false);
   assert.equal(result.serviceQuery,false);
   assert.equal(result.reviewContinuationTextOnly,true);
   assert.equal(reviews.length,1);
   assert.equal(audit[0][0],"finalOutgoingLanguageMismatch");
  }
 }
});
