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
 const decide=(text,state,extra={})=>salesFollowUpIntent({config,customerText:text,parsed:{
   structured:true,outcome:"normal",details:{salesFollowUpIntent:state,salesFollowUpEvidence:text},...extra}});
 assert.equal(decide("哦！太远了","declined"),"declined");
 assert.equal(decide("等确定了，我再联系你","deferred"),"deferred");
 assert.equal(decide("Ok","declined"),null);
 assert.equal(decide("How much?","reopened",{priceQuery:true}),"reopened");
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
