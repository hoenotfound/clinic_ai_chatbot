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
 assert.match(server,/priced\.restored && priced\.optionalClarification === true && pricingAuthorityRequired && !approvedPricingDecision/u);
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

test("assessment-first text rewrite is deferred only when the mandatory verified price formatter will run",()=>{
 const {deferAssessmentPricingRewrite}=require("../src/utils/neutroAiReplyAuthority");
 const config={businessType:"tcm_clinic",businessName:"Neutro Sense",aiPricingIntentMode:"enabled",
  aiReplyAuthorityMode:"enabled",automatedFollowUp:{assessmentFirstPricingEnabled:true}};
 const args={config,pricingAuthorityRequired:true,formatterWillRun:true};
 assert.equal(deferAssessmentPricingRewrite(args),true);
 for(const changes of [{formatterWillRun:false},{pricingAuthorityRequired:false},{marketingStopQuestion:"stop"},
  {config:{...config,aiReplyAuthorityMode:"legacy"}},{config:{...config,automatedFollowUp:{}}}]){
  assert.equal(deferAssessmentPricingRewrite({...args,...changes}),false);
 }
 const {ensureVerifiedPriceReply}=require("../src/utils/verifiedPriceReply");
 for(const reply of ["骨盆调理 RM999","Price RM999","RM999"]){
  const verified=ensureVerifiedPriceReply({customerText:"价格怎么算",reply,pricingDecision:null,
    priceRequested:true,preserveNaturalReply:true});
  assert.doesNotMatch(verified.reply,/RM999/u);
 }
});

test("zero-cost claims are not neutral and cannot escape the price formatter",()=>{
 const {isSafeUnquotedReply,hasComplimentaryPriceClaim,ensureVerifiedPriceReply}=require("../src/utils/verifiedPriceReply");
 for(const reply of ["不收费","不收取费用","收费为零","无需付款","No charge","at no cost","You don't have to pay","Zero fees","Tanpa caj","Tidak perlu bayar","Bayaran sifar"]){
  assert.equal(hasComplimentaryPriceClaim(reply),true,reply);
  assert.equal(isSafeUnquotedReply(reply),false,reply);
  for(const priceRequested of [false,true]){
   const result=ensureVerifiedPriceReply({customerText:priceRequested?"多少钱":"如何护理",reply,
    pricingDecision:null,priceRequested,aiFirstReplyAuthority:true});
   assert.equal(result.restored,true,reply);
   assert.notEqual(result.optionalClarification,true,reply);
   assert.equal(hasComplimentaryPriceClaim(result.reply),false,reply);
  }
 }
});
test("only optional price clarification may be suppressed; frequency and recovery facts remain mandatory",()=>{
 const {ensureVerifiedPriceReply}=require("../src/utils/verifiedPriceReply");
 const base={pricingDecision:null,priceRequested:true,preserveNaturalReply:true,aiFirstReplyAuthority:true};
 const safe=ensureVerifiedPriceReply({...base,customerText:"多少钱",reply:"请问你想了解哪项护理呢？"});
 assert.equal(safe.optionalClarification,true);
 for(const [customerText,reply] of [["多少钱？需要做几次？","保证三次见效"],["多少钱？恢复期多久？","没有恢复期"],["How much and how long is recovery?","No downtime guaranteed."],["Berapa harga? Berapa kali?","Tiga sesi dijamin."]]){
  const result=ensureVerifiedPriceReply({...base,customerText,reply});
  assert.equal(result.restored,true,customerText);
  assert.equal(result.optionalClarification,false,customerText);
  assert.notEqual(result.reply,reply);
 }
});
test("verified complimentary assessment wording is preserved only for that exact offer",()=>{
 const {verifiedComplimentaryAssessmentDraft,ensureVerifiedPriceReply}=require("../src/utils/verifiedPriceReply");
 const config=require("../src/config/clinicConfig");
 const prev=config.automatedFollowUp;
 try{
  config.automatedFollowUp={...prev,complimentaryAssessmentExperienceEnabled:true};
  const input={customerText:"1对1体态评估收费吗？",language:"zh",aiFirstReplyAuthority:true,preserveNaturalReply:true,pricingDecision:null};
  const good="是的😊 1对1体态评估+体验是免费的哦";
  assert.equal(verifiedComplimentaryAssessmentDraft(good,"zh"),true);
  assert.equal(ensureVerifiedPriceReply({...input,reply:good}).reply,good);
  for(const reply of ["骨盆调理不收费","1对1体态评估+体验免费，正式疗程也免费","1对1体态评估+体验免费，保证一次见效","1对1体态评估+体验免费，已帮你预约"]){
   assert.equal(verifiedComplimentaryAssessmentDraft(reply,"zh"),false);
   assert.notEqual(ensureVerifiedPriceReply({...input,reply}).reply,reply);
  }
 }finally{config.automatedFollowUp=prev;}
});
test("neutral wording cannot veto independently approved promotion artwork",()=>{
 const {allowsApprovedPromotionWithoutTextQuote}=require("../src/utils/verifiedPriceReply");
 const decision={source:"model_led_customer_context",type:"price",treatment:"骨盆调理",prices:[{name:"Package A",price:"RM388"},{name:"Package B",price:"RM268"}]};
 for(const reply of ["目前有两个护理配套哦 😊","Of course, we have two care packages.","Boleh, kami ada dua pakej penjagaan."]){
  assert.equal(allowsApprovedPromotionWithoutTextQuote({decision,reply}),true,reply);
  assert.equal(allowsApprovedPromotionWithoutTextQuote({decision:null,reply}),false);
 }
 for(const reply of ["Package A RM999","Package A RM388","不收费","No charge","我会发送图片给你","保证三次见效"]){
  assert.equal(allowsApprovedPromotionWithoutTextQuote({decision,reply}),false,reply);
 }
});

test("verified administrative and campaign drafts can retain courtesy without changing facts or review state",()=>{
 const {selectVerifiedRoutineReply,routineReviewTextOnlyState}=require("../src/utils/neutroAiReplyAuthority");
 const {confirmedBusinessHoursAnswer,verifyBusinessHoursDraft}=require("../src/utils/verifiedPricingBusinessFacts");
 const config={businessType:"tcm_clinic",businessName:"Neutro Sense TCM",aiPricingIntentMode:"enabled",aiReplyAuthorityMode:"enabled"};
 const answer=confirmedBusinessHoursAnswer({customerText:"Opening hours?",language:"en",hours:{weekly:{
  monday:null,tuesday:{open:"10:00",close:"20:00"},wednesday:{open:"10:00",close:"20:00"},thursday:{open:"10:00",close:"20:00"},friday:{open:"10:00",close:"20:00"},saturday:{open:"10:00",close:"18:00"},sunday:{open:"10:00",close:"18:00"}
 }}});
 assert.ok(answer);
 const draft="Hello 😊 "+answer.reply+" Thank you.";
 assert.equal(verifyBusinessHoursDraft(draft,answer,{allowNeutralCourtesy:true}),true);
 assert.equal(selectVerifiedRoutineReply({config,answer,draft,language:"en"}),draft);
 for(const bad of [draft+" Monday appointments available.",draft.replace("20:00","22:00"),draft+" RM68",draft+" Booked."]){
  assert.equal(verifyBusinessHoursDraft(bad,answer,{allowNeutralCourtesy:true}),false);
  assert.equal(selectVerifiedRoutineReply({config,answer,draft:bad,language:"en"}),answer.reply);
 }
 const campaign={kind:"verified_rm68_campaign",reply:"The centre needs to confirm availability."};
 const campaignDraft="Of course! "+campaign.reply+" Thanks!";
 assert.equal(selectVerifiedRoutineReply({config,answer:campaign,draft:campaignDraft,language:"en"}),campaignDraft);
 assert.equal(selectVerifiedRoutineReply({config,answer:campaign,draft:campaignDraft+" You're booked.",language:"en"}),campaign.reply);
 assert.equal(selectVerifiedRoutineReply({config:{...config,aiReplyAuthorityMode:"legacy"},answer:campaign,draft:campaignDraft,language:"en"}),campaign.reply);
 assert.equal(routineReviewTextOnlyState({pendingClinicalReview:true},campaignDraft),null);
});

test("verified complimentary assessment invitations remain natural without authorizing free paid treatments",()=>{
 const {ensureVerifiedPriceReply,verifiedComplimentaryAssessmentInvitation}=require("../src/utils/verifiedPriceReply");
 const config=require("../src/config/clinicConfig"),previous=config.automatedFollowUp;
 try {
  const good=[
   ["zh","我们可以先帮您安排免费的1对1体态评估及体验哦 😊"],
   ["en","We can arrange a complimentary 1-on-1 posture assessment and introductory experience."],
   ["ms","Kami boleh aturkan penilaian postur 1-ke-1 dan sesi pengenalan percuma."]
  ];
  for(const enabled of [true,false]){
   config.automatedFollowUp={...previous,complimentaryAssessmentExperienceEnabled:enabled};
   for(const [language,reply] of good){
    assert.equal(verifiedComplimentaryAssessmentInvitation(reply,language),true,reply);
    const input={customerText:"I want to know about pelvic care",reply,language,pricingDecision:null,
      aiFirstReplyAuthority:true,preserveNaturalReply:true,priceRequested:false};
    const result=ensureVerifiedPriceReply(input);
    assert.equal(result.reply===reply,enabled,reply);
   }
  }
  config.automatedFollowUp={...previous,complimentaryAssessmentExperienceEnabled:true};
  const correct=good[0][1];
  const combined="我们会先了解您的体态情况。"+correct;
  assert.equal(ensureVerifiedPriceReply({customerText:"想了解骨盆调理",reply:combined,pricingDecision:null,aiFirstReplyAuthority:true}).reply,combined);
  for(const reply of [correct+"，正式疗程也免费",correct+"。骨盆调理不收费",correct+"。已预约成功，免费",correct+"。保证三次见效",correct+"。RM999"]){
   const result=ensureVerifiedPriceReply({customerText:"想了解骨盆调理",reply,pricingDecision:null,aiFirstReplyAuthority:true});
   assert.notEqual(result.reply,reply,reply);
  }
 }finally{config.automatedFollowUp=previous;}
});
test("actual rejected-price boundary retains independently verified guidance and never reauthorizes media",()=>{
 const fs=require("node:fs"),vm=require("node:vm");
 const {ensureVerifiedPriceReply,isSafeUnquotedReply}=require("../src/utils/verifiedPriceReply");
 const {suppressConversationalRewrite,createReplyOverrideAudit}=require("../src/utils/neutroAiReplyAuthority");
 const source=fs.readFileSync(require.resolve("../src/server.js"),"utf8");
 const start=source.indexOf("    if ((staffPriceConflict || rejectedModelPricing) && !flagged");
 const end=source.indexOf("    // A generic recovery choice",start);
 assert.ok(start>0&&end>start);
 for(const [text,draft,language] of [
  ["多少钱？恢复期多久？","保证没有恢复期","zh"],
  ["How much and how many sessions?","Guaranteed cure after three sessions","en"],
  ["Berapa harga? Berapa kali?","Tiga sesi dijamin.","ms"]
 ]){
  const result=ensureVerifiedPriceReply({customerText:text,reply:draft,language,pricingDecision:null,priceRequested:true,aiFirstReplyAuthority:true});
  assert.ok(result.verifiedNonPriceGuidance,text);
  for(const staffPriceConflict of [true,false]){
   const ctx={text,reply:result.reply,verifiedPricingNonPriceGuidance:result.verifiedNonPriceGuidance,
    staffPriceConflict,rejectedModelPricing:!staffPriceConflict,flagged:false,bookingReady:false,
    rm68CampaignContinuationTextOnly:false,repeatVisitPriceReply:null,marketingStopQuestion:false,
    reviewContinuationTextOnly:false,naturalReplyAuthority:true,mediaLanguage:language,
    clinicConfig:{businessType:"tcm_clinic",businessName:"Neutro Sense",aiPricingIntentMode:"enabled",aiReplyAuthorityMode:"enabled"},
    replyOverrideAudit:createReplyOverrideAudit(()=>{}),isSafeUnquotedReply,suppressConversationalRewrite,
    shouldRewriteRejectedPricingReply:()=>true};
   const final=vm.runInNewContext(source.slice(start,end)+"\n({reply,reviewContinuationTextOnly})",ctx);
   assert.ok(final.reply.includes(result.verifiedNonPriceGuidance),final.reply);
   assert.equal(final.reply.split(result.verifiedNonPriceGuidance).length,2);
   assert.equal(final.reviewContinuationTextOnly,true);
   assert.ok(!final.reply.includes(draft));
  }
 }
});

test("live package A regression preserves all four configured inclusions after removing an unauthorized quote",()=>{
 const {ensureVerifiedPriceReply}=require("../src/utils/verifiedPriceReply");
 const fixture=require("./fixtures/neutro-pricing-assessment-20261127.json");
 const pack=fixture.promotions[0].packages.find(p=>p.name==="Package A");
 const cases=[
  ["zh","Package A 包含什么？","Package A（尊享护理配套｜全程约2小时30分钟）包含：","额外收费 RM999","我们会发送图片给你"],
  ["en","What does Package A include?","Package A (2 hours 30 minutes) includes:","Price RM999","I will send the image"],
  ["ms","Apa yang termasuk dalam Pakej A?","Pakej A (2 jam 30 minit) termasuk:","Harga RM999","Saya akan hantar gambar"],
 ];
 for(const [language,customerText,heading,wrongPrice,mediaPromise] of cases){
  const items=pack.mediaTranslations[language].caption.split("\n").filter(x=>x.startsWith("✅"));
  assert.equal(items.length,4);
  const valid=[heading,...items].join("\n");
  const base={customerText,language,pricingDecision:null,priceRequested:false,aiFirstReplyAuthority:true,preserveNaturalReply:true,
   services:fixture.services,serviceAliases:fixture.serviceAliases,promotions:fixture.promotions};
  const draft=[heading,items[0],items[1],wrongPrice,items[2],items[3],mediaPromise].join("\n");
  const result=ensureVerifiedPriceReply({...base,reply:draft});
  assert.equal(result.restored,true,language);
  assert.equal(result.reply,valid,language);
  assert.equal(ensureVerifiedPriceReply({...base,reply:valid}).reply,valid,language);
  const legacy=ensureVerifiedPriceReply({...base,aiFirstReplyAuthority:false,reply:draft});
  assert.ok(!legacy.reply.includes(items[3]),"legacy cap remains unchanged");
 }
});
test("AI-first commercial cleanup retains complete clauses rather than cutting at 340 characters",()=>{
 const {ensureVerifiedPriceReply}=require("../src/utils/verifiedPriceReply");
 const lines=Array.from({length:7},()=> "Our practitioner explains the care process and what to expect during your visit.");
 const safe=lines.join("\n");
 assert.ok(safe.length>340);
 const result=ensureVerifiedPriceReply({customerText:"Tell me about the care process",reply:safe+"\nPrice RM999",
  pricingDecision:null,priceRequested:false,language:"en",aiFirstReplyAuthority:true});
 assert.equal(result.reply,safe);
});
test("simple acknowledgement does not restart treatment introduction after mandatory pricing cleanup",()=>{
 const {ensureVerifiedPriceReply}=require("../src/utils/verifiedPriceReply");
 for(const [language,customerText,safe,unsafe,expected] of [
  ["zh","哦","好的呀 😊","骨盆调理现在只需 RM999","好的哦 😊"],
  ["en","I see","Okay 😊","Price RM999","Of course 😊"],
  ["ms","Baik","Baik ya 😊","Harga RM999","Baik 😊"]
 ]){
  const input={customerText,language,pricingDecision:null,priceRequested:false,aiFirstReplyAuthority:true,preserveNaturalReply:true};
  const untouched=ensureVerifiedPriceReply({...input,reply:safe});
  assert.equal(untouched.restored,false);
  assert.equal(untouched.reply,safe);
  const corrected=ensureVerifiedPriceReply({...input,reply:unsafe});
  assert.equal(corrected.restored,true);
  assert.equal(corrected.reply,expected);
  const mixed=ensureVerifiedPriceReply({...input,reply:safe+"\n"+unsafe});
  assert.equal(mixed.reply,safe);
  assert.doesNotMatch(ensureVerifiedPriceReply({...input,reply:"No charge"}).reply,/no charge/iu);
  assert.notEqual(ensureVerifiedPriceReply({...input,customerText:customerText+"，多少钱？",priceRequested:true,reply:unsafe}).reply,expected);
 }
});
