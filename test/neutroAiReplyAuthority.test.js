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
