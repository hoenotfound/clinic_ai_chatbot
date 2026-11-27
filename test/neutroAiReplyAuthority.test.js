"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {usesNaturalReplyAuthority,recordedReviewAcknowledgement,createReplyOverrideAudit}=require("../src/utils/neutroAiReplyAuthority");
const {categorizeAiReview}=require("../src/utils/aiReviewPolicy");
const {guardAssessmentFirstPricingReply}=require("../src/utils/initialOfferReplyGuard");
test("scope natural authority to enabled Neutro TCM",()=>{
  const cfg={businessType:"tcm_clinic",businessName:"Neutro Sense TCM",aiPricingIntentMode:"enabled"};
  assert.equal(usesNaturalReplyAuthority(cfg),true);
  assert.equal(usesNaturalReplyAuthority({...cfg,aiPricingIntentMode:"shadow"}),false);
  assert.equal(usesNaturalReplyAuthority({...cfg,businessName:"Other Clinic"}),false);
});
test("structured administrative assignment review does not downgrade clinical signals",()=>{
  const opt={trustStructuredInformation:true};
  assert.equal(categorizeAiReview("请问是广告里的这位医师下手做吗","information",opt),"information");
  assert.equal(categorizeAiReview("请问是广告里的这位中医师吗","information",opt),"information");
  for(const text of ["我有乳房肿块","我刚做过手术","我怀孕了可以做吗","I have urinary leakage","我有糖尿病"]){
    assert.equal(categorizeAiReview(text,"information",opt),"clinical",text);
  }
  assert.equal(categorizeAiReview("请问是广告里的这位医师下手做吗","clinical",opt),"clinical");
});
test("natural noncommercial replies pass price guard unchanged",()=>{
  const reply="Hi! Thanks for getting in touch 😊 我们提供全身脉冲波调理。";
  const result=guardAssessmentFirstPricingReply({reply,customerText:"全身吗",preserveNaturalReply:true});
  assert.equal(result.reply,reply);
  assert.equal(result.replaced,false);
});
test("review acknowledgement makes no unverified medical or commercial claim",()=>{
  for(const lang of ["zh","en","ms"]){
    const info=recordedReviewAcknowledgement("information",lang);
    const clinical=recordedReviewAcknowledgement("clinical",lang);
    assert.ok(info&&clinical&&info!==clinical);
    assert.doesNotMatch(info+clinical,/RM\s*\d+/);
  }
});
test("override audit records labels and IDs without customer content",()=>{
  const logs=[];const a=createReplyOverrideAudit(x=>logs.push(x));
  assert.equal(a.change("unchanged","same","same"),"same");
  assert.equal(a.change("guard","private customer text","private replacement"),"private replacement");
  a.flush({contactId:1,inboundId:2,original:"private customer text",final:"private replacement",outcome:"normal"});
  assert.equal(logs.length,1);
  assert.match(logs[0],/"reasons":\["guard"\]/);
  assert.doesNotMatch(logs[0],/private|unchanged/);
});

test("model closure is allowed only after verified delivery and never for an actionable response",()=>{
  const {canHonorNoReply}=require("../src/utils/neutroAiReplyAuthority");
  const config={businessType:"tcm_clinic",businessName:"Neutro Sense",aiPricingIntentMode:"enabled"};
  const parsed={structured:true,outcome:"no_reply",text:"不客气",details:{}};
  const args={config,parsed,customerText:"谢谢",contact:{needs_attention:false},
    history:[{role:"assistant",content:"我们的门店在PJ。",pricingDeliveredBotMessage:true},{role:"user",content:"谢谢"}]};
  assert.equal(canHonorNoReply(args),true);
  assert.equal(canHonorNoReply({...args,parsed:{...parsed,outcome:"normal"}}),false);
  assert.equal(canHonorNoReply({...args,contact:{needs_attention:true}}),false);
  assert.equal(canHonorNoReply({...args,parsed:{...parsed,details:{appointmentScheduling:true}}}),false);
  assert.equal(canHonorNoReply({...args,history:[{...args.history[0],content:"你想安排几点？"},args.history[1]]}),false);
  assert.equal(canHonorNoReply({...args,customerText:"👌",history:[{...args.history[0],content:"可以帮您安排预约哦"},{role:"user",content:"👌"}]}),false);
  assert.equal(canHonorNoReply({...args,history:[{...args.history[0],pricingDeliveredBotMessage:false},args.history[1]]}),false);
  for(const text of ["OK","可以","我怀孕了","多少钱","明天","stop","我要预约","要怎么付款"]){
    assert.equal(canHonorNoReply({...args,customerText:text,history:[args.history[0],{role:"user",content:text}]}),false,text);
  }
});

test("AI-led location fallback supplies only verified branch facts without a scripted invitation",()=>{
  const {confirmedSingleBranchLocationAnswer,verifyLocationDraft}=require("../src/utils/verifiedPricingBusinessFacts");
  const branches=[{name:"Petaling Jaya",address:"12 Jalan 19, Petaling Jaya, Selangor"}];
  for(const [lang,question] of [["zh","地址在哪里?"],["en","Where is your clinic?"],["ms","Di mana lokasi klinik?"]]){
    const options={customerText:question,branches,language:lang,resolvedLanguage:lang,modelLocationOnly:true};
    const expected=confirmedSingleBranchLocationAnswer(options);
    const actual=confirmedSingleBranchLocationAnswer({...options,modelLocationOnly:false,omitInvitation:true});
    assert.ok(expected,question);
    assert.ok(actual,question);
    assert.equal(actual.reply,expected.reply);
    assert.ok(actual.reply.includes(branches[0].address));
    assert.doesNotMatch(actual.reply,/\?|？/);
  }
});

test("model sales decisions require current evidence; reopening requires a genuine enquiry",()=>{
 const {salesFollowUpIntent}=require("../src/utils/neutroAiReplyAuthority");
 const config={businessType:"tcm_clinic",businessName:"Neutro Sense",aiPricingIntentMode:"enabled"};
 const decide=(text,state,extra={},verifiedReopen=false)=>salesFollowUpIntent({config,customerText:text,verifiedReopen,parsed:{
   structured:true,outcome:"normal",details:{salesFollowUpIntent:state,salesFollowUpEvidence:text},...extra}});
 assert.equal(decide("哦！太远了","declined"),"declined");
 assert.equal(decide("等确定了，我再联系你","deferred"),"deferred");
 assert.equal(decide("Ok","declined"),null);
 assert.equal(decide("How much?","reopened",{priceQuery:true}),null);
 assert.equal(decide("How much?","reopened",{priceQuery:true},true),"reopened");
 assert.equal(decide("Thank you","reopened"),null);
 assert.equal(decide("Too far, how much?","declined",{priceQuery:true}),null);
 assert.equal(decide("太远了","declined",{details:{salesFollowUpIntent:"declined",salesFollowUpEvidence:"old"}}),null);
});
test("social OK and smile can end a delivered explicit closing, never an open invitation",()=>{
 const {canHonorNoReply}=require("../src/utils/neutroAiReplyAuthority");
 const config={businessType:"tcm_clinic",businessName:"Neutro Sense",aiPricingIntentMode:"enabled"};
 const check=(text,prior)=>canHonorNoReply({config,parsed:{structured:true,outcome:"no_reply",details:{}},customerText:text,
   history:[{role:"assistant",content:prior,pricingDeliveredBotMessage:true},{role:"user",content:text}]});
 assert.equal(check("Ok","好的，祝你有美好的一天，有过来随时找我们哦 😊"),true);
 assert.equal(check("😄","随时欢迎你～祝你顺心！"),true);
 assert.equal(check("Ok","你想安排预约吗？"),false);
 assert.equal(check("Ok","我们的门店在PJ。"),false);
 assert.equal(check("😄","请问哪天方便，祝你顺心"),false);
});

test("a second smile after a suppressed OK still closes, without skipping a new request",()=>{
 const {canHonorNoReply}=require("../src/utils/neutroAiReplyAuthority");
 const config={businessType:"tcm_clinic",businessName:"Neutro Sense",aiPricingIntentMode:"enabled"};
 const history=[{role:"assistant",content:"随时欢迎你～祝你顺心！",pricingDeliveredBotMessage:true},
 {role:"user",content:"Ok"},{role:"user",content:"😄"}];
 const args={config,parsed:{structured:true,outcome:"no_reply",details:{}},customerText:"😄",history};
 assert.equal(canHonorNoReply(args),true);
 assert.equal(canHonorNoReply({...args,history:[history[0],{role:"user",content:"How much?"},history[2]]}),false);
});

test("closure never bypasses open booking or payment restrictions",()=>{
 const {canHonorNoReply}=require("../src/utils/neutroAiReplyAuthority");
 const config={businessType:"tcm_clinic",businessName:"Neutro Sense",aiPricingIntentMode:"enabled"};
 for(const prior of ["You can arrange an appointment anytime, take care","随时欢迎你来预约","Feel free to contact us for booking"]){
  assert.equal(canHonorNoReply({config,parsed:{structured:true,outcome:"no_reply",details:{}},customerText:"Ok",
   history:[{role:"assistant",content:prior,pricingDeliveredBotMessage:true},{role:"user",content:"Ok"}]}),false,prior);
 }
});
test("sales preference write locks conversation, accepts older decisions and is idempotent by source",async()=>{
 const {persistSalesFollowUpIntent,SALES_STATE_INSERT_SQL}=require("../src/utils/neutroAiReplyAuthority");
 const calls=[];const db={connect:async()=>({query:async(sql,args)=>{calls.push({sql,args});return {rows:sql===SALES_STATE_INSERT_SQL?[{id:1}]:[]};},release(){}})};
 assert.equal(await persistSalesFollowUpIntent({database:db,contactId:2,inboundId:3,customerText:"Too far",intent:"declined"}),true);
 assert.equal(calls[0].sql,"BEGIN");assert.match(calls[1].sql,/pg_advisory_xact_lock/);
 assert.doesNotMatch(SALES_STATE_INSERT_SQL,/newer\.id>inbound\.id/);
 assert.match(SALES_STATE_INSERT_SQL,/existing\.metadata->>'inboundMessageId'/);
 assert.equal(calls.at(-1).sql,"COMMIT");
});

test("AI reply authority rollout is independent, scoped and reversible",()=>{
 const {resolveAiReplyAuthorityMode,suppressConversationalRewrite}=require("../src/utils/neutroAiReplyAuthority");
 const base={businessType:"tcm_clinic",businessName:"Neutro Sense TCM",aiPricingIntentMode:"enabled"};
 for(const mode of [undefined,"legacy","invalid"]){
  const config={...base,aiReplyAuthorityMode:mode};
  assert.equal(resolveAiReplyAuthorityMode(config),"legacy");
  assert.equal(suppressConversationalRewrite(config,null,"unapprovedPriceClarification"),false);
 }
 for(const mode of ["observe","enabled"]){
  const config={...base,aiReplyAuthorityMode:mode};
  assert.equal(resolveAiReplyAuthorityMode(config),mode);
  for(const reason of ["unapprovedPriceClarification","improveRepeatedPriceClarification","rejectedModelPricingClarification","optionalComboUpsell"])
   assert.equal(suppressConversationalRewrite(config,null,reason),true,reason);
  for(const reason of ["clinicalSafety","ensureVerifiedPriceReply","guardAiAppointmentReply","marketingStopReply","guardUnconfirmedMediaPromise","correctReplyLanguage","staffPriceConflict","fixedAdFirstReply"])
   assert.equal(suppressConversationalRewrite(config,null,reason),false,reason);
  assert.equal(resolveAiReplyAuthorityMode({...config,aiPricingIntentMode:"shadow"}),"legacy");
  assert.equal(resolveAiReplyAuthorityMode({...config,businessName:"Other Clinic"}),"legacy");
 }
});
test("observation records skipped optional rewrites without storing content",()=>{
 const {suppressConversationalRewrite}=require("../src/utils/neutroAiReplyAuthority");
 const logs=[],audit=createReplyOverrideAudit(x=>logs.push(x));
 const config={businessType:"tcm_clinic",businessName:"Neutro Sense",aiPricingIntentMode:"enabled",aiReplyAuthorityMode:"observe"};
 assert.equal(suppressConversationalRewrite(config,audit,"improveRepeatedPriceClarification"),true);
 audit.flush({contactId:1,inboundId:2,original:"private draft",final:"private draft",outcome:"normal"});
 assert.equal(logs.length,1);
 assert.match(logs[0],/"suppressed":\["improveRepeatedPriceClarification"\]/u);
 assert.match(logs[0],/"changed":false/u);
 assert.doesNotMatch(logs[0],/private|unattributed/u);
 const enabled=createReplyOverrideAudit(x=>logs.push(x));
 assert.equal(suppressConversationalRewrite({...config,aiReplyAuthorityMode:"enabled"},enabled,"optionalComboUpsell"),true);
 enabled.flush({original:"unchanged",final:"unchanged",outcome:"normal"});
 assert.equal(logs.length,1);
});
test("unapproved pricing may preserve neutral wording but never unverified commercial claims",()=>{
 const {isSafeUnquotedReply}=require("../src/utils/verifiedPriceReply");
 for(const reply of ["你想了解哪个护理配套的费用呢？","我可以先帮你确认目前的价格哦 😊","你是想了解正式护理还是评估呢？","Which treatment do you mean?","Let me check the price with the centre.","Harga rawatan yang mana ya?","Saya boleh semak harga dahulu."]){
  assert.equal(isSafeUnquotedReply(reply),true,reply);
 }
 for(const reply of ["Package A RM388","现在只需 RM2️⃣6️⃣8️⃣","费用 88","Price 88","It costs eighty ringgit","费用八百","免费的","It is free","Percuma","RM100 优惠券","I'll send you the package details","我现在发给你参考看看","Saya akan hantar gambar promosi",""]){
  assert.equal(isSafeUnquotedReply(reply),false,reply);
 }
});
test("runtime only suppresses optional wording and optional combo media, not verified price or action decisions",()=>{
 const fs=require("node:fs"),path=require("node:path");
 const server=fs.readFileSync(path.join(__dirname,"../src/server.js"),"utf8");
 assert.match(server,/priced\.restored && pricingAuthorityRequired && !approvedPricingDecision/u);
 assert.match(server,/!twoTreatmentQuote && !staffPriceConflict && !verifiedPriceService/u);
 assert.match(server,/isSafeUnquotedReply\(reply\) &&\s*suppressConversationalRewrite\(clinicConfig,replyOverrideAudit,"unapprovedPriceClarification"\)/u);
 assert.match(server,/comboOfferDecision\?\.mode==="suggestion" &&\s*suppressConversationalRewrite\(clinicConfig,replyOverrideAudit,"optionalComboUpsell"\)\)\s*comboOfferDecision=null/u);
 assert.match(server,/staffPriceConflict \|\| !isSafeUnquotedReply\(reply\)/u);
 assert.match(server,/reviewContinuationTextOnly = true;/u);
 assert.match(server,/guardAiAppointmentReply/u);
 assert.match(server,/resolveApprovedPricingAssessment/u);
 assert.match(server,/guardUnfulfilledPriceQuote/u);
 const repo=fs.readFileSync(path.join(__dirname,"../src/db/configRepo.js"),"utf8");
 const routes=fs.readFileSync(path.join(__dirname,"../src/routes/config.js"),"utf8");
 const settings=fs.readFileSync(path.join(__dirname,"../portal-frontend/src/pages/Settings.jsx"),"utf8");
 assert.match(repo,/"aiReplyAuthorityMode"/u);
 assert.match(routes,/aiReplyAuthorityMode: \(v\) => \["legacy", "observe", "enabled"\]\.includes\(v\)/u);
 assert.match(settings,/value=\{form\.aiReplyAuthorityMode\}/u);
});
