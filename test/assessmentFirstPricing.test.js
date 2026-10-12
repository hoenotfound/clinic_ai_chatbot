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
  const options = {customerText: initial, reply: "骨盆套餐 RM388 / RM288", treatment: "骨盆调理",language:"zh"};
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
