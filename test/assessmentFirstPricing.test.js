"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config/clinicConfig");
const { hasExplicitPriceRequest } = require("../src/utils/customerEnquiryEvidence");
const {
  hasTreatmentPriceContent,
  guardAssessmentFirstPricingReply,
} = require("../src/utils/initialOfferReplyGuard");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");

const initial = "Hi～我想了解 Neutro Sense TCM 的骨盆调理。之后可以 WhatsApp 跟进我，有相关优惠也可以通知我 😊";

test("current monetary price requests differ from treatment/package interest and marketing permission", () => {
  for (const message of [
    "骨盆调理多少钱？", "配套价格？", "price?", "What's the price for 3D?",
    "how much is 9D?", "berapa harga untuk rawatan pelvis?",
    "RM388?", "这两个疗程收费多少？",
  ]) assert.equal(hasExplicitPriceRequest(message), true, message);

  for (const message of [
    initial, "我想了解骨盆调理", "有什么配套？", "配套包括什么？",
    "你们有优惠吗？", "Can I see the package options?",
    "What does package A include?", "Any promotion?",
    "到店做评估可以领取 RM100 优惠券吗？",
    "Do you have an RM100 voucher?", "Can I claim voucher RM100?",
    "不用告诉我价钱", "How long is the 9D session?",
  ]) assert.equal(hasExplicitPriceRequest(message), false, message);

  assert.equal(hasExplicitPriceRequest(initial + "。现在骨盆调理多少钱？"), true);
  assert.equal(hasExplicitPriceRequest("My budget is RM300"),false);
  assert.equal(hasExplicitPriceRequest("我的预算 RM300"),false);
  assert.equal(hasExplicitPriceRequest("价格不是问题"),false);
  assert.equal(hasExplicitPriceRequest("我比较在意价格"),false);
  assert.equal(hasExplicitPriceRequest("Price is not an issue"),false);
  assert.equal(hasExplicitPriceRequest("RM388?"),true);

});

test("RM100 voucher is permitted but treatment prices in all common formats are blocked", () => {
  for (const reply of [
    "到店完成评估 + 体验可领 RM100 骨盆调理疗程优惠券。",
    "到店可以领取 RM100 优惠券 😊",
    "Receive an RM100 voucher for attending the assessment.",
    "Dapat baucar RM100 selepas hadir.",
    "先做 1对1 体态评估+体验，再考虑疗程。",
    "联络我们 017-483 1336",
  ]) assert.equal(hasTreatmentPriceContent(reply), false, reply);
  for (const reply of [
    "骨盆调理配套 RM388 和 RM288。",
    "这个疗程现价 388。",
    "Only RM3️⃣8️⃣8️⃣ today.",
    "RM100 voucher, then package B is RM288.",
    "Original price RM488.",
  ]) assert.equal(hasTreatmentPriceContent(reply), true, reply);
});

test("assessment-first outbound guard works for any message turn/channel but never blocks a direct price request", () => {
  const options = {customerText: initial, reply: "骨盆套餐 RM388 / RM288", treatment: "骨盆调理",language:"zh",services:[{name:"骨盆调理"}]};
  for (const channel of ["whatsapp", "facebook", "instagram"]) {
    const out = guardAssessmentFirstPricingReply({...options, channel});
    assert.equal(out.replaced, true);
    assert.match(out.reply, /1对1的体态评估/);
    assert.match(out.reply, /RM100/);
    assert.equal(hasTreatmentPriceContent(out.reply), false);
  }
  const voucherOnly = "完成评估 + 体验可领 RM100 骨盆调理疗程优惠券。";
  assert.deepEqual(guardAssessmentFirstPricingReply({...options, reply:voucherOnly}),{
    reply:voucherOnly,replaced:false
  });
  const priceAsked = "现在配套多少钱？";
  assert.deepEqual(guardAssessmentFirstPricingReply({...options,customerText:priceAsked}),{
    reply:options.reply,replaced:false
  });
  assert.deepEqual(guardAssessmentFirstPricingReply({...options,flagged:true}),{
    reply:options.reply,replaced:false
  });
});

test("promotion images now require a monetary price enquiry, not package browsing", async () => {
  const input = {
    priceQuery:false,packageQuery:true,treatment:"骨盆调理",
    customerText:"有什么配套？",textSendSucceeded:true,contactId:18,
    promotions:[{name:"Pelvis",linkedService:"骨盆调理",sendOnPriceQuery:true,
      packages:[{name:"Package A",imageUrl:"https://example.test/a.jpg",caption:"RM388"}]}],
    wasPromoRecentlySent:async()=>false,
    hasUnconfirmedMediaDelivery:async()=>false,
  };
  const existing = config.automatedFollowUp;
  config.automatedFollowUp = {...existing, assessmentFirstPricingEnabled:true};
  try {
    assert.equal(await resolvePricePromotionForReply(input),null);
    const bundle=await resolvePricePromotionForReply({...input,
      customerText:"配套多少钱？",priceQuery:true});
    assert.equal(bundle?.packages?.[0]?.caption,"RM388");
  } finally {
    config.automatedFollowUp = existing;
  }
});

test("assessment-first prompt hides package prices unless the current customer asks for money", () => {
  const saved=JSON.parse(JSON.stringify(config));
  try {
    Object.assign(config, {
      businessName:"Neutro Sense TCM",clinicName:"Neutro Sense TCM",businessType:"tcm_clinic",
      aiAssistantName:"Neutro assistant",
      automatedFollowUp:{...config.automatedFollowUp,assessmentFirstPricingEnabled:true},
      services:[{name:"骨盆调理",description:"POSTURE_SERVICE",duration:"40 minutes",priceRange:"PRICE_SENTINEL RM388"}],
      promotions:[{name:"Pelvic packages",linkedService:"骨盆调理",sendOnPriceQuery:true,
        packages:[{name:"Package A",caption:"PRICE_SENTINEL RM388",imageUrl:"https://example.test/a.jpg"}]}],
      serviceAliases:[],faqs:[],branches:[],
    });
    const context=(currentCustomerText)=>({
      currentCustomerText,relevantServiceNames:["骨盆调理"],serviceSource:"current_customer",
      promotionIntent:true,schedulingIntent:false,contactIntent:false,
    });
    const enquiry=buildSystemPrompt({channel:"whatsapp",conversationContext:context("有什么配套？")});
    assert.match(enquiry,/ASSESSMENT-FIRST PRICING POLICY/);
    assert.doesNotMatch(enquiry,/PRICE_SENTINEL/);
    const asked=buildSystemPrompt({channel:"whatsapp",conversationContext:context("配套多少钱？")});
    assert.match(asked,/PRICE_SENTINEL/);
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config,saved);
  }
});

test("runtime has independent fail-closed checks for scheduled pricing and static promotion paths",()=>{
  const root=path.resolve(__dirname,"../src");
  const pricing=fs.readFileSync(path.join(root,"services/pricingReminderService.js"),"utf8");
  const following=fs.readFileSync(path.join(root,"services/followUpService.js"),"utf8");
  const freeEntry=fs.readFileSync(path.join(root,"utils/freeEntryTemplateSelection.js"),"utf8");
  const server=fs.readFileSync(path.join(root,"server.js"),"utf8");
  assert.match(pricing,/async function sendPricingReminder[\s\S]*?assessmentFirstPricingEnabled/);
  assert.match(pricing,/async function runPricingReminders[\s\S]*?assessmentFirstPricingEnabled/);
  assert.match(following,/function promotionFollowUpForCandidate[\s\S]*?assessmentFirstPricingEnabled/);
  assert.match(freeEntry,/assessmentFirstPricingEnabled[\s\S]*?ns_fu_pricing_graphic/);
  assert.match(server,/guardAssessmentFirstPricingReply\(/);
});


test("saving Follow-up Tools cannot erase assessment-first or re-enable automatic price reminders", () => {
  const { prepareConfigUpdatePayload } = require("../src/routes/config");
  const step = {
    enabled:true,triggerMode:"all",activatedAt:"2026-10-10T00:00:00Z",
    assessmentFirstPricingEnabled:true,delayMinutes:120,message:"Follow up safely",
    translations:{en:"Follow up safely",ms:"Follow up safely",zh:"Follow up safely"},
    imageUrl:"",videoKey:"",serviceOverrides:[],additionalSteps:[],
    quietHours:{enabled:true,start:"00:00",end:"07:00"},
    pricingReminder:{enabled:false,requirePricingInterest:true},
  };
  const current={services:[{name:"骨盆调理"}],automatedFollowUp:step};
  const saved = prepareConfigUpdatePayload({
    automatedFollowUp:{...step,message:"New follow up copy",assessmentFirstPricingEnabled:undefined,
      pricingReminder:{enabled:true}},
  },current);
  assert.equal(saved.ok,true,JSON.stringify(saved));
  assert.equal(saved.updates.automatedFollowUp.assessmentFirstPricingEnabled,true);
  assert.equal(saved.updates.automatedFollowUp.pricingReminder.enabled,false);
  const malicious=prepareConfigUpdatePayload({
    automatedFollowUp:{...step,assessmentFirstPricingEnabled:false},
  },current);
  assert.equal(malicious.ok,false);

  const legacy=prepareConfigUpdatePayload({
    automatedFollowUp:{...step,assessmentFirstPricingEnabled:false},
  },{...current,automatedFollowUp:{...step,assessmentFirstPricingEnabled:undefined}});
  assert.equal(legacy.ok,true,"legacy clients must still save their existing Follow-up Tools");
});

test("new price guard retains useful treatment explanations while removing unwanted price sentences",()=>{
  const { stripUnsolicitedTreatmentPrice, assessmentFirstInvitation } =
    require("../src/utils/initialOfferReplyGuard");
  const original="骨盆调理会先根据体态做评估。现在 RM388，另有 RM288。你比较在意小腹还是腰髋紧呢？";
  const guarded=guardAssessmentFirstPricingReply({
    customerText:"我想了解骨盆调理",reply:original,language:"zh",
    treatment:"骨盆调理",services:[{name:"骨盆调理"}],
  });
  assert.equal(guarded.replaced,true);
  assert.match(guarded.reply,/根据体态做评估/);
  assert.match(guarded.reply,/小腹还是腰髋紧/);
  assert.equal(hasTreatmentPriceContent(guarded.reply),false);
  assert.equal(stripUnsolicitedTreatmentPrice(original),guarded.reply);
  const face=assessmentFirstInvitation({
    customerText:"想了解3D小颜术和体态评估",treatment:"3D 小颜术",language:"zh",
    services:[{name:"3D 小颜术"},{name:"骨盆调理"}],
  });
  assert.match(face,/3D 小颜术/);
  assert.match(face,/评估/);
  assert.doesNotMatch(face,/RM100|骨盆调理疗程优惠券/);
  const unknown=assessmentFirstInvitation({
    customerText:"想改善体态",treatment:null,language:"zh",
    services:[{name:"骨盆调理"}],
  });
  assert.doesNotMatch(unknown,/RM100/);
});

test("short Malay 'berapa?' uses a verified service context, not a bare assumption",async()=>{
  const { isContextualBarePriceQuestion }=require("../src/utils/customerEnquiryEvidence");
  assert.equal(isContextualBarePriceQuestion("Berapa?",null),false);
  assert.equal(hasExplicitPriceRequest("Berapa?"),false);
  assert.equal(hasExplicitPriceRequest("Berapa?",{treatment:"骨盆调理"}),true);
  assert.equal(hasExplicitPriceRequest("Berapa lama?",{treatment:"骨盆调理"}),false);
  const existing=config.automatedFollowUp;
  config.automatedFollowUp={...existing,assessmentFirstPricingEnabled:true};
  try{
    const args={
      priceQuery:true,packageQuery:false,treatment:"3D 小颜术",customerText:"Berapa?",
      contactId:44,textSendSucceeded:true,
      promotions:[{name:"3D First Trial",linkedService:"3D 小颜术",sendOnPriceQuery:true,
        imageUrl:"https://example.test/3d.jpg",caption:"RM488"}],
      wasPromoRecentlySent:async()=>false,
      hasUnconfirmedMediaDelivery:async()=>false,
    };
    assert.equal((await resolvePricePromotionForReply(args))?.packages?.length,1);
    assert.equal(await resolvePricePromotionForReply({...args,treatment:null}),null);
    assert.equal(await resolvePricePromotionForReply({...args,customerText:"Berapa lama?"}),null);
  }finally{config.automatedFollowUp=existing;}
});

test("fixed/targeted-media follow-ups are checked before saving even when AI is bypassed",()=>{
  const { enforceAssessmentFirstFollowUpCopy }=require("../src/services/followUpService");
  const oldConfig={automatedFollowUp:config.automatedFollowUp,services:config.services,
    serviceAliases:config.serviceAliases};
  try{
    config.automatedFollowUp={...config.automatedFollowUp,assessmentFirstPricingEnabled:true};
    config.services=[{name:"骨盆调理"},{name:"3D 小颜术"}];
    config.serviceAliases=[{alias:"3D",officialService:"3D 小颜术"}];
    const pelvic=enforceAssessmentFirstFollowUpCopy({
      message:"限时优惠 RM388",language:"zh",targetedService:"骨盆调理",
      candidate:{recent_inbound_messages:["我想了解骨盆调理"]},
    });
    assert.equal(pelvic.suppressMedia,true);
    assert.match(pelvic.message,/RM100/);
    assert.doesNotMatch(pelvic.message,/RM388/);
    const facial=enforceAssessmentFirstFollowUpCopy({
      message:"3D First Trial RM488",language:"zh",targetedService:"3D 小颜术",
      candidate:{recent_inbound_messages:["想了解3D"]},
    });
    assert.equal(facial.suppressMedia,true);
    assert.doesNotMatch(facial.message,/RM100|RM488/);
    const safe=enforceAssessmentFirstFollowUpCopy({
      message:"欢迎你先做评估 + 体验",language:"zh",targetedService:"骨盆调理",
    });
    assert.equal(safe.suppressMedia,false);
    assert.equal(safe.message,"欢迎你先做评估 + 体验");
  }finally{Object.assign(config,oldConfig);}
});

test("comment prompt shows verified prices only on current explicit comment price questions",()=>{
  const saved=JSON.parse(JSON.stringify(config));
  try{
    Object.assign(config,{
      businessName:"Neutro Sense TCM",clinicName:"Neutro Sense TCM",businessType:"tcm_clinic",
      aiAssistantName:"Customer Service",
      automatedFollowUp:{...config.automatedFollowUp,assessmentFirstPricingEnabled:true},
      services:[{name:"3D 小颜术",description:"Facial consultation",duration:"90 mins",priceRange:"PRICE_SENTINEL RM888"}],
      promotions:[{name:"3D First Trial",linkedService:"3D 小颜术",sendOnPriceQuery:true,
        caption:"PROMO_SENTINEL RM488"}],
      serviceAliases:[],faqs:[],branches:[],
    });
    const noPrice=buildSystemPrompt({surface:"comment_automation",channel:"instagram",
      commentText:"我想了解3D小颜术"});
    assert.doesNotMatch(noPrice,/PRICE_SENTINEL|PROMO_SENTINEL/);
    const price=buildSystemPrompt({surface:"comment_automation",channel:"instagram",
      commentText:"3D 小颜术多少钱？"});
    assert.match(price,/PRICE_SENTINEL/);
    assert.match(price,/PROMO_SENTINEL/);
  }finally{
    for(const k of Object.keys(config)) delete config[k];
    Object.assign(config,saved);
  }
});

test("price-containing AI follow-up is regenerated once without losing valid follow-up",async()=>{
  const aiService=require("../src/services/aiService");
  const { generatePersonalizedFollowUp }=require("../src/services/followUpAiService");
  const prior=aiService.getReplyWithEnv,settings=config.automatedFollowUp;
  const prompts=[];let attempts=0;
  config.automatedFollowUp={...settings,assessmentFirstPricingEnabled:true};
  aiService.getReplyWithEnv=async (_messages,options)=>{
    prompts.push(options.followUpContext?.avoidMessage||"");
    return JSON.stringify({
      action:"send",
      message: attempts++===0 ? "骨盆评估现在 RM388，想来吗？" :
        "你可以先过来了解1对1体态评估 + 体验 😊 平日还是周末方便？",
      reason:"Follow-up",topic:"骨盆调理",
    });
  };
  try{
    const result=await generatePersonalizedFollowUp({
      conversation:[{id:1,role:"user",content:"想了解骨盆调理"}],
      triggerMessageId:1,stepNumber:1,treatmentInterest:"骨盆调理",
    });
    assert.equal(attempts,2);
    assert.match(prompts[1],/price|价格/i);
    assert.equal(result.action,"send");
    assert.doesNotMatch(result.message,/RM388/);
  }finally{
    aiService.getReplyWithEnv=prior;
    config.automatedFollowUp=settings;
  }
});


test("price image IDs configured as promotions are never recycled into price-free follow-ups",()=>{
  const { isConfiguredPromotionPriceGraphic }=require("../src/services/followUpService");
  const promos=[{name:"Pelvis",imageUrl:"https://clinic.example/promo-images/31",
    packages:[{name:"Package A",imageUrl:"/promo-images/33",followUpImageUrl:"https://clinic.example/promo-images/34"}]}];
  assert.equal(isConfiguredPromotionPriceGraphic("https://cdn.example/promo-images/31?exp=10",promos),true);
  assert.equal(isConfiguredPromotionPriceGraphic("/promo-images/33",promos),true);
  assert.equal(isConfiguredPromotionPriceGraphic("/promo-images/34",promos),true);
  assert.equal(isConfiguredPromotionPriceGraphic("/api/config/result-media/image/11",promos),false);
  assert.equal(isConfiguredPromotionPriceGraphic("",promos),false);
});


test("Malaysian colloquial money questions are explicit while package exploration remains price-free", () => {
  const { hasCustomerPriceEnquiry } = require("../src/utils/customerEnquiryEvidence");
  for (const enquiry of [
    "骨盆几钱？", "3D幾錢", "几多钱", "请问价位？", "PM 价钱",
    "p.m. 价钱", "price pls", "berapa harga ya", "RM388?",
  ]) {
    assert.equal(hasExplicitPriceRequest(enquiry), true, enquiry);
    assert.equal(hasCustomerPriceEnquiry(enquiry), true, enquiry);
  }
  for (const nonPrice of [
    "几次会有效？", "几多疗程？", "我的预算 RM300", "价格不是问题",
    "有什么配套？", "有优惠可以通知我", "how much longer to recover?",
    "Do you have an RM100 voucher?",
  ]) {
    assert.equal(hasExplicitPriceRequest(nonPrice), false, nonPrice);
  }
});

test("verified first service enquiry gets an assessment invite while keeping the reply and existing result eligibility", () => {
  const { ensureFirstAssessmentInvitation } = require("../src/utils/initialOfferReplyGuard");
  const services=[{name:"骨盆调理"},{name:"3D 小颜术"}];
  const opts={isFirstMessage:true,services,serviceQuery:true,language:"zh",serviceAliases:[{alias:"3D",officialService:"3D 小颜术"},{alias:"骨盆",officialService:"骨盆调理"}]};
  const text="我们是徒手调理，通常根据体态安排体验 😊";
  const pelvis=ensureFirstAssessmentInvitation({...opts,reply:text,customerText:"想了解骨盆调理",treatment:"骨盆调理"});
  assert.equal(pelvis.appended,true);
  const existingQuestion = ensureFirstAssessmentInvitation({...opts,reply:"骨盆护理主要关注腰臀和体态。你最困扰哪方面？",customerText:"想了解骨盆调理",treatment:"骨盆调理"});
  assert.equal(existingQuestion.appended,true);
  assert.equal((existingQuestion.reply.match(/[?？]/gu)||[]).length,1,"avoid repeating two questions");

  assert.match(pelvis.reply,/我们是徒手调理/);
  assert.match(pelvis.reply,/1对1/);
  assert.match(pelvis.reply,/RM100/);
  assert.equal(hasTreatmentPriceContent(pelvis.reply),false);
  const face=ensureFirstAssessmentInvitation({...opts,reply:text,customerText:"想了解3D小颜术",treatment:"3D 小颜术"});
  assert.equal(face.appended,true);
  assert.match(face.reply,/1对1/);
  assert.doesNotMatch(face.reply,/RM100|骨盆调理优惠券/);
  const untouched=[
    {...opts,isFirstMessage:false,customerText:"想了解骨盆调理",treatment:"骨盆调理"},
    {...opts,customerText:"骨盆多少钱？",treatment:"骨盆调理"},
    {...opts,customerText:"我想了解这个",serviceQuery:false,treatment:null},
    {...opts,customerText:"我想了解骨盆调理",flagged:true,treatment:"骨盆调理"},
    {...opts,customerText:"想了解骨盆和3D",treatment:"骨盆调理"},
  ];
  for(const input of untouched) assert.equal(ensureFirstAssessmentInvitation({...input,reply:text}).appended,false,JSON.stringify(input));
  assert.equal(ensureFirstAssessmentInvitation({...opts,reply:text,customerText:"我想了解骨盆调理",serviceQuery:false,treatment:"骨盆调理"}).appended,true);
  assert.equal(ensureFirstAssessmentInvitation({...opts,reply:text,customerText:"我想了解这个",treatment:"骨盆调理"}).appended,false);
  assert.equal(ensureFirstAssessmentInvitation({...opts,reply:text,customerText:"想了解骨盆调理",treatment:"骨盆调理",
    verifiedAdService:"骨盆调理",}).appended,true);
  assert.equal(ensureFirstAssessmentInvitation({...opts,reply:text,customerText:"3D还是骨盆调理哪个好?",treatment:"骨盆调理",
    verifiedAdService:"骨盆调理"}).appended,false,"mixed services cannot be resolved from ad alone");
  assert.equal(ensureFirstAssessmentInvitation({...opts,reply:text,customerText:"想了解这个",treatment:"骨盆调理",
    verifiedAdService:"骨盆调理"}).appended,true,"verified contextual ad service is eligible");
  const alreadyInvited = ensureFirstAssessmentInvitation({...opts,reply:text+"\\n\\n你可以先做1对1评估",customerText:"想了解骨盆调理",treatment:"骨盆调理"});
  assert.equal(alreadyInvited.appended,true);
  assert.match(alreadyInvited.reply,/RM100/);
  assert.equal(ensureFirstAssessmentInvitation({...opts,reply:text+"\\n\\n你可以先做1对1评估，领取 RM100 优惠券",customerText:"想了解骨盆调理",treatment:"骨盆调理"}).appended,false);
});

test("AI missing the priceQuery flag cannot drop a verified treatment price graphic",async()=>{
  const old=config.automatedFollowUp;
  config.automatedFollowUp={...old,assessmentFirstPricingEnabled:true};
  const args={
    priceQuery:false,packageQuery:false,
    treatment:"骨盆调理",verifiedServiceFromText:"骨盆调理",
    customerText:"骨盆几钱?",textSendSucceeded:true,contactId:81,
    promotions:[{name:"Pelvis",linkedService:"骨盆调理",sendOnPriceQuery:true,
      packages:[{name:"Package A",imageUrl:"https://example.test/a.jpg",caption:"RM388"}]}],
    wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,
  };
  try{
    const result=await resolvePricePromotionForReply(args);
    assert.equal(result?.packages?.[0]?.caption,"RM388");
    assert.equal(await resolvePricePromotionForReply({...args,verifiedServiceFromText:null}),null);
    assert.equal(await resolvePricePromotionForReply({...args,customerText:"有什么配套？"}),null);
    assert.equal(await resolvePricePromotionForReply({...args,customerText:"骨盆多少钱",flagged:true}),null);
    assert.equal(await resolvePricePromotionForReply({...args,customerText:"骨盆多少钱",needsAttention:true}),null);
    assert.equal(await resolvePricePromotionForReply({...args,customerText:"骨盆多少钱",textSendSucceeded:false}),null);
  }finally{config.automatedFollowUp=old;}
});


test("standalone Malay/Chinese price follow-ups use only the immediately established service",async()=>{
  const { isStandalonePriceQuestion }=require("../src/utils/customerEnquiryEvidence");
  const { safeServiceFromCustomer }=require("../src/utils/initialOfferReplyGuard");
  for(const q of ["berapa?", "Berapa ya?", "多少钱？", "几钱？", "price?", "how much?"]){
    assert.equal(isStandalonePriceQuestion(q),true,q);
  }
  for(const q of ["berapa kali?", "berapa lama?", "how much longer?", "my budget RM300", "几多疗程", "any packages?"]){
    assert.equal(isStandalonePriceQuestion(q),false,q);
  }
  const services=[{name:"骨盆调理"},{name:"3D 小颜术"}];
  const known=safeServiceFromCustomer("我想了解骨盆调理",services,[]);
  assert.equal(known?.name,"骨盆调理");
  assert.equal(safeServiceFromCustomer("3D还是骨盆调理?",services,[{alias:"3D",officialService:"3D 小颜术"}]),null);
  const old=config.automatedFollowUp;
  config.automatedFollowUp={...old,assessmentFirstPricingEnabled:true};
  try{
    const out=await resolvePricePromotionForReply({
      priceQuery:false,packageQuery:false,treatment:known.name,verifiedServiceFromText:known.name,
      customerText:"Berapa?",textSendSucceeded:true,contactId:3,
      promotions:[{name:"Pelvic",linkedService:known.name,sendOnPriceQuery:true,
        packages:[{name:"Package B",caption:"RM288",imageUrl:"https://example.test/pelvicB.jpg"}]}],
      wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,
    });
    assert.equal(out?.packages?.[0]?.caption,"RM288");
    assert.equal(await resolvePricePromotionForReply({
      priceQuery:false,packageQuery:false,treatment:known.name,verifiedServiceFromText:null,
      customerText:"Berapa?",textSendSucceeded:true,contactId:3,
      promotions:[{name:"Pelvic",linkedService:known.name,sendOnPriceQuery:true,
        packages:[{name:"Package B",caption:"RM288",imageUrl:"https://example.test/pelvicB.jpg"}]}],
      wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,
    }),null);
  }finally{config.automatedFollowUp=old;}
});


test("price affordability remarks never enable assessment-first monetary media", async () => {
  const old=config.automatedFollowUp;
  config.automatedFollowUp={...old, assessmentFirstPricingEnabled:true};
  const { hasCustomerPriceEnquiry }=require("../src/utils/customerEnquiryEvidence");
  const offers=[{ name:"Pelvis",linkedService:"骨盆调理",sendOnPriceQuery:true,
    packages:[{name:"Package A",caption:"RM388",imageUrl:"https://example.test/pelvicA.jpg"}]}];
  const base={
    priceQuery:true,packageQuery:true,treatment:"骨盆调理",verifiedServiceFromText:"骨盆调理",
    textSendSucceeded:true,contactId:301,promotions:offers,
    wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,
  };
  try {
    for(const s of ["骨盆调理的价位太高了", "价位有点贵", "这个价格太贵了", "价格不是问题", "这个价位偏高", "harga mahal sangat"]) {
      assert.equal(hasExplicitPriceRequest(s),false,s);
      assert.equal(await resolvePricePromotionForReply({...base,customerText:s}),null,s);
    }
    for(const s of ["请问骨盆调理价位？", "价位？", "骨盆调理几钱？", "price pls", "骨盆调理多少钱？"]) {
      assert.equal(hasExplicitPriceRequest(s),true,s);
    }
    assert.equal(hasCustomerPriceEnquiry("价位有点贵"),false,"affordability statements must not trigger promotional media");
  } finally { config.automatedFollowUp=old; }
});

test("model priceQuery cannot select one image for ambiguous multi-treatment enquiries", async () => {
  const old=config.automatedFollowUp;
  config.automatedFollowUp={...old,assessmentFirstPricingEnabled:true};
  const base={
    priceQuery:true,packageQuery:true,treatment:"骨盆调理",verifiedServiceFromText:null,
    textSendSucceeded:true,contactId:302,promotions:[{name:"Pelvis",linkedService:"骨盆调理",sendOnPriceQuery:true,
      packages:[{name:"Package A",imageUrl:"https://example.test/a.jpg",caption:"RM388"}]}],
    wasPromoRecentlySent:async()=>false,hasUnconfirmedMediaDelivery:async()=>false,
  };
  try {
    for(const s of ["3D 和骨盆调理分别多少钱？","骨盆和9D什么价钱？"]) {
      assert.equal(await resolvePricePromotionForReply({...base,customerText:s}),null,s);
    }
    assert.equal(await resolvePricePromotionForReply({...base,customerText:"骨盆调理多少钱？",verifiedServiceFromText:"3D 小颜术"}),null);
    const yes=await resolvePricePromotionForReply({...base,customerText:"骨盆调理多少钱？",verifiedServiceFromText:"骨盆调理"});
    assert.equal(yes?.packages?.length,1);
  } finally { config.automatedFollowUp=old; }
});

test("first assessment invite is suppressed for independent clinical red flags despite clean Gemini flags", () => {
  const {ensureFirstAssessmentInvitation}=require("../src/utils/initialOfferReplyGuard");
  const args={isFirstMessage:true,flagged:false,reply:"骨盆调理可帮助改善整体体态。",services:[{name:"骨盆调理"}],
    treatment:"骨盆调理",language:"zh"};
  for(const customerText of ["我怀孕了，想了解骨盆调理","骨盆调理适合刚做完手术的人吗？","剖腹产后两周想了解骨盆调理", "骨盆调理会不会很痛？"]) {
    const got=ensureFirstAssessmentInvitation({...args,customerText});
    assert.equal(got.appended,false,customerText);
    assert.doesNotMatch(got.reply,/到店完成评估|RM100/);
  }
  assert.equal(ensureFirstAssessmentInvitation({...args,customerText:"我想了解骨盆调理"}).appended,true);
});
