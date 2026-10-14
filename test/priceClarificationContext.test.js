"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { resolveClarifiedPriceService } = require("../src/utils/priceClarificationContext");
const { buildConversationPromptContext } = require("../src/utils/conversationPromptContext");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");
const { guardAssessmentFirstPricingReply } = require("../src/utils/initialOfferReplyGuard");
const { ensureVerifiedPriceReply, configuredOfferPrice } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const services = [
  { name: "骨盆调理", description: "Pelvic care", priceRange: "", duration: "40 minutes" },
  { name: "3D 小颜术", description: "Facial care", priceRange: "RM488", duration: "90 minutes" },
];
const serviceAliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "骨盆调整", officialService: "骨盆调理" },
  { alias: "3D", officialService: "3D 小颜术" },
];
const promotions = [{
  name: "骨盆调理套餐",
  linkedService: "骨盆调理",
  sendOnPriceQuery: true,
  packages: [
    {
      name: "Package A",
      title: "尊享护理配套｜2小时30分钟",
      imageUrl: "https://example.test/a.jpg",
      caption: "本月限时优惠 🔥\nRM100 优惠券限时领取\n原价优惠 RM488\n优惠后仅需 RM3️⃣8️⃣8️⃣",
    },
    {
      name: "Package B",
      title: "1小时30分钟女性护理配套",
      imageUrl: "https://example.test/b.jpg",
      caption: "本月限时优惠 🔥 RM100 OFF\n原价 RM388\n现在只需 RM2️⃣8️⃣8️⃣",
    },
  ],
}];
const clarification = "请问你想了解哪一项疗程的价格呢？我可以帮你确认 😊";
const konnyHistory = [
  { role: "user", content: "想大概了解价钱" },
  { role: "assistant", content: clarification },
  { role: "user", content: "调整骨盆" },
];
function resolve(history, current = history.at(-1)?.content) {
  return resolveClarifiedPriceService({
    customerText: current,
    conversationHistory: history,
    services,
    serviceAliases,
  });
}
function withAssessmentFirst(fn) {
  const previous = config.automatedFollowUp;
  config.automatedFollowUp = {
    ...previous, assessmentFirstPricingEnabled: true,
  };
  return Promise.resolve().then(fn).finally(() => {
    config.automatedFollowUp = previous;
  });
}

test("Konny's immediate named-treatment answer completes the preceding price enquiry", () => {
  assert.equal(resolve(konnyHistory), "骨盆调理");
  assert.equal(resolve([
    { role: "user", content: "How much does it cost?" },
    { role: "assistant", content: "Which treatment would you like the price for?" },
    { role: "user", content: "Pelvic" },
  ]), null, "An unconfigured English treatment nickname must not imply pelvic pricing");
  assert.equal(resolve([
    { role: "user", content: "Boleh tahu harga?" },
    { role: "assistant", content: "Boleh saya tahu harga untuk rawatan yang mana satu ya?" },
    { role: "user", content: "骨盆调理" },
  ]), "骨盆调理");
  assert.equal(resolve([
    { role: "user", content: "Price?" },
    { role: "assistant", content: "Which treatment would you like the price for?" },
    { role: "user", content: "3D 小颜术" },
  ]), "3D 小颜术");
});

test("A past price question, ordinary consultation, staff reply, refusal or ambiguous service never permits prices", () => {
  const blocks = [
    [{ role:"user", content:"想了解骨盆护理" }, { role:"assistant", content:clarification }, { role:"user", content:"调整骨盆" }],
    [{ role:"user", content:"想大概了解价钱" }, { role:"assistant", content:"你平时有腰酸吗？" }, { role:"user", content:"调整骨盆" }],
    [{ role:"user", content:"想大概了解价钱" }, { role:"assistant", content:"[Verified STAFF message] "+clarification }, { role:"user", content:"调整骨盆" }],
    [...konnyHistory.slice(0,2), { role:"user", content:"不用价钱，我想了解骨盆" }],
    [...konnyHistory.slice(0,2), { role:"user", content:"想了解骨盆调理和3D小颜术" }],
    [...konnyHistory.slice(0,2), { role:"user", content:"另外想了解骨盆调理" }],
    [...konnyHistory.slice(0,2), { role:"user", content:"调整骨盆" }, { role:"assistant", content:"明白" }, { role:"user", content:"调整骨盆" }],
    [{ role:"user", content:"Hi，之后有优惠也发给我" }, { role:"assistant", content:clarification }, { role:"user", content:"骨盆调理" }],
  ];
  for (const history of blocks) assert.equal(resolve(history), null, JSON.stringify(history));
});

test("AI prompt exposes active pelvic prices only for a verified completed clarification", () => {
  const snapshot = JSON.parse(JSON.stringify(config));
  try {
    Object.assign(config, {
      businessName:"Neutro Sense TCM", clinicName:"Neutro Sense TCM",
      businessType:"tcm_clinic", services, serviceAliases, promotions,
      automatedFollowUp:{...config.automatedFollowUp,assessmentFirstPricingEnabled:true},
      faqs:[],branches:[],
    });
    const currentContext = buildConversationPromptContext(konnyHistory, {
      services, aliases: serviceAliases, promotions,
    });
    assert.equal(currentContext.clarifiedPriceService, "骨盆调理");
    assert.deepEqual(currentContext.relevantServiceNames, ["骨盆调理"]);
    const allowed = buildSystemPrompt({
      channel:"whatsapp", conversationContext:currentContext,
    });
    assert.match(allowed, /RM3️⃣8️⃣8️⃣/);
    assert.match(allowed, /RM2️⃣8️⃣8️⃣/);
    const unsolicited = buildSystemPrompt({
      channel:"whatsapp",
      conversationContext:buildConversationPromptContext([
        { role:"user", content:"我想了解骨盆调理" },
      ], { services, aliases:serviceAliases, promotions }),
    });
    assert.doesNotMatch(unsolicited, /优惠后仅需 RM3️⃣8️⃣8️⃣/);
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, snapshot);
  }
});

test("final price guard permits a verified clarification but not a standalone treatment name", () => {
  const base = {
    customerText:"调整骨盆", reply:"Package A RM388，Package B RM288",
    treatment:"骨盆调理", requireVerifiedTreatment:true, services,
    serviceAliases, resultMedia:[], conversationHistory:konnyHistory, language:"zh",
  };
  assert.deepEqual(guardAssessmentFirstPricingReply({
    ...base, clarifiedPriceService:"骨盆调理",
  }), {reply:base.reply,replaced:false});
  const blocked = guardAssessmentFirstPricingReply({
    ...base, clarifiedPriceService:null,
  });
  assert.equal(blocked.replaced,true);
  assert.doesNotMatch(blocked.reply,/RM388|RM288/);
});

test("verified pricing fallback quotes the real active A/B prices, not an extra RM100 voucher", () => {
  assert.equal(configuredOfferPrice(promotions[0].packages[0].caption),"RM388");
  assert.equal(configuredOfferPrice(promotions[0].packages[1].caption),"RM288");
  assert.equal(configuredOfferPrice("RM100 优惠券限时领取"),null);
  assert.equal(configuredOfferPrice("原价 RM488"),null);
  const options = {
    customerText:"调整骨盆",
    reply:"骨盆调理目前有当期的配套优惠哦～可以先来做评估 😊",
    treatment:"骨盆调理", clarifiedPriceService:"骨盆调理",
    services, serviceAliases, promotions, resultMedia:[],
    conversationHistory:konnyHistory, language:"zh",
  };
  const restored = ensureVerifiedPriceReply(options);
  assert.equal(restored.restored,true);
  assert.match(restored.reply,/Package A.*RM388/su);
  assert.match(restored.reply,/Package B.*RM288/su);
  assert.doesNotMatch(restored.reply,/RM100\s*(?:折|OFF)/iu);
  assert.equal(ensureVerifiedPriceReply({
    ...options, clarifiedPriceService:null,
  }).restored,false);
  assert.equal(ensureVerifiedPriceReply({
    ...options, promotions:[], 
  }).restored,false);
  assert.equal(ensureVerifiedPriceReply({
    ...options, reply:"Package A RM388，Package B RM288",
  }).restored,false);
  assert.equal(ensureVerifiedPriceReply({
    ...options, treatment:"3D 小颜术",
  }).restored,false);
});

test("verified clarification can select both price graphics, with unchanged send and safety gates", async () => {
  await withAssessmentFirst(async () => {
    const options = {
      priceQuery:false,packageQuery:false,treatment:"骨盆调理",
      verifiedServiceFromText:"骨盆调理",
      customerText:"调整骨盆", conversationHistory:konnyHistory,
      textSendSucceeded:true,contactId:450,promotions,
      services,serviceAliases,resultMedia:[],language:"zh",
      wasPromoRecentlySent:async()=>false,
      hasUnconfirmedMediaDelivery:async()=>false,
    };
    const prices = await resolvePricePromotionForReply(options);
    assert.deepEqual(prices?.packages.map((p)=>p.name),["Package A","Package B"]);
    assert.equal(await resolvePricePromotionForReply({
      ...options, verifiedServiceFromText:null,
    }),null);
    assert.equal(await resolvePricePromotionForReply({
      ...options, textSendSucceeded:false,
    }),null);
    assert.equal(await resolvePricePromotionForReply({
      ...options, customerText:"腰酸腿疼",
      conversationHistory:[...konnyHistory,{role:"assistant",content:"好的"},{role:"user",content:"腰酸腿疼"}],
    }),null);
    assert.equal(await resolvePricePromotionForReply({
      ...options, hasUnconfirmedMediaDelivery:async()=>true,
    }),null);
    assert.equal(await resolvePricePromotionForReply({
      ...options, wasPromoRecentlySent:async()=>true,
    }),null);
  });
});
