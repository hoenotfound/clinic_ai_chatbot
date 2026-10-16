"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMetaAdReplyContext } = require("../src/services/metaAdReplyContextService");
const { resolveAiPricingDecision } = require("../src/utils/aiPricingIntentDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const services = [
  { name: "3D 小颜术" },
  { name: "9D 逆龄抗衰" },
  { name: "骨盆调理" },
];
const serviceAliases = [
  { alias: "小颜术", officialService: "3D 小颜术" },
  { alias: "3D", officialService: "3D 小颜术" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
  { alias: "骨盆", officialService: "骨盆调理" },
];
const promotions = [
  {
    name: "3D First Trial", linkedService: "3D 小颜术",
    sendOnPriceQuery: true, imageUrl: "https://example.test/3d.png",
    caption: "3D First Trial 现价 RM488 (原价 RM888)",
    pricing: { currency: "MYR", offer: 488, normal: 888 },
  },
  {
    name: "9D First Trial", linkedService: "9D 逆龄抗衰",
    sendOnPriceQuery: true, imageUrl: "https://example.test/9d.png",
    caption: "9D First Trial 现价 RM488 (原价 RM1288)",
    pricing: { currency: "MYR", offer: 488, normal: 1288 },
  },
  {
    name: "骨盆套餐", linkedService: "骨盆调理", sendOnPriceQuery: true,
    imageUrl: "", caption: "",
    packages: [
      { name: "Package A", imageUrl: "https://example.test/a.png",
        caption: "现价 RM388", pricing: { currency: "MYR", offer: 388, normal: 488 } },
      { name: "Package B", imageUrl: "https://example.test/b.png",
        caption: "现价 RM288", pricing: { currency: "MYR", offer: 288, normal: 388 } },
    ],
  },
];

function context(adName, headline = "欢迎了解") {
  return normalizeMetaAdReplyContext({
    source: "meta_ads", ad_name: adName, headline, body: "",
  }, { services, aliases: serviceAliases });
}

function decide({ customerText = "价格?", conversationHistory, metaAdContext,
  treatment = null, priceQuery = true, ...overrides } = {}) {
  return resolveAiPricingDecision({
    priceQuery, treatment, customerText,
    conversationHistory: conversationHistory ||
      [{ role: "user", content: customerText }],
    metaAdContext, services, serviceAliases, promotions,
    ...overrides,
  });
}

async function promotionFor(decision, current, history, extra = {}) {
  return resolvePricePromotionForReply({
    aiPricingEnabled: true, pricingDecision: decision,
    treatment: decision?.treatment || null,
    verifiedServiceFromText: decision?.treatment || null,
    customerText: current, conversationHistory: history,
    flagged: false, bookingReady: false, keywordReason: null,
    needsAttention: false, textSendSucceeded: true,
    promotions, services, serviceAliases, resultMedia: [],
    language: "zh", contactId: 55,
    wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    ...extra,
  });
}

test("Neutro ad 小颜术 6 plus 地址? then 价格? resolves verified RM488 and 3D graphic", async () => {
  const metaAdContext = context("小颜术 6");
  assert.equal(metaAdContext?.serviceHint, "3D 小颜术");
  assert.equal(metaAdContext?.serviceHintSource, "ad_name");
  const history = [
    { role: "user", content: "想了解" },
    { role: "assistant", content: "这里有3D小颜术顾客的 Before & After。" },
    { role: "user", content: "地址?" },
    { role: "assistant", content: "我们在 Petaling Jaya。" },
    { role: "user", content: "价格?" },
  ];
  const decision = decide({
    priceQuery: false, customerText: "价格?",
    conversationHistory: history, metaAdContext,
  });
  assert.equal(decision?.source, "meta_ad");
  assert.equal(decision?.treatment, "3D 小颜术");
  assert.deepEqual(decision?.prices?.map(p => p.price), ["RM488"]);

  const text = ensureVerifiedPriceReply({
    customerText: "价格?", reply: "请问你想了解哪项疗程的价格呢？",
    treatment: decision.treatment, pricingDecision: decision,
    priceRequested: true, language: "zh",
    promotions, services, serviceAliases, conversationHistory: history,
  });
  assert.match(text.reply, /3D 小颜术/);
  assert.match(text.reply, /RM488/);
  assert.doesNotMatch(text.reply, /哪项疗程|哪一项疗程/);

  const graphic = await promotionFor(decision, "价格?", history);
  assert.deepEqual(graphic?.packages?.map(p => p.imageUrl),
    ["https://example.test/3d.png"]);
});

test("a uniquely identified creative can establish an early 9D price question", async () => {
  const metaAdContext = context("generic campaign", "9D 逆龄抗衰体验");
  assert.equal(metaAdContext?.serviceHintSource, "creative");
  const history = [{ role: "user", content: "How much?" }];
  const decision = decide({ customerText: "How much?",
    conversationHistory: history, metaAdContext });
  assert.equal(decision?.treatment, "9D 逆龄抗衰");
  assert.deepEqual(decision?.prices?.map(p => p.price), ["RM488"]);
  const graphic = await promotionFor(decision, "How much?", history);
  assert.deepEqual(graphic?.packages?.map(p => p.imageUrl),
    ["https://example.test/9d.png"]);
});

test("pelvic ad selects the configured packages, without inventing a single sale price", async () => {
  const metaAdContext = context("骨盆 1");
  const history = [{ role: "user", content: "多少钱?" }];
  const decision = decide({ customerText: "多少钱?",
    conversationHistory: history, metaAdContext });
  assert.equal(decision?.treatment, "骨盆调理");
  assert.deepEqual(decision?.prices?.map(p => p.price), ["RM388", "RM288"]);
  const graphic = await promotionFor(decision, "多少钱?", history);
  assert.deepEqual(graphic?.packages?.map(p => p.name), ["Package A", "Package B"]);
});

test("later customer-named treatment outranks the first-touch ad", () => {
  const metaAdContext = context("小颜术 6");
  const history = [
    { role: "user", content: "我想了解9D 逆龄抗衰" },
    { role: "assistant", content: "好的，9D有什么想了解的？" },
    { role: "user", content: "价格?" },
  ];
  const decision = decide({ customerText: "价格?",
    conversationHistory: history, treatment: "9D 逆龄抗衰", metaAdContext });
  assert.equal(decision?.treatment, "9D 逆龄抗衰");
  assert.equal(decision?.source, "recent_customer");

  // Even when the model mistakenly keeps the 3D label, do not send the old
  // ad's price instead of overriding the customer's explicit 9D selection.
  assert.equal(decide({ customerText: "价格?",
    conversationHistory: history, treatment: "3D 小颜术", metaAdContext }), null);
});

test("Meta context cannot authorize an ambiguous, stale or contradicted quote", () => {
  const valid = context("小颜术 6");
  const conditions = [
    { metaAdContext: null },
    { metaAdContext: { serviceHint: "3D 小颜术" } },
    { metaAdContext: context("3D + 9D", "3D 小颜术 和 9D 逆龄抗衰") },
    { metaAdContext: context("3D 小颜术 + 骨盆") },
    { metaAdContext: valid, treatment: "9D 逆龄抗衰" },
    { metaAdContext: valid, customerText: "全部疗程价格?" },
    { metaAdContext: valid, customerText: "停车费多少钱?" },
    { metaAdContext: valid, customerText: "有优惠可以发我" },
    { metaAdContext: valid, customerText: "免费评估多少钱?",
      complimentaryAssessmentExperienceEnabled: true },
    { metaAdContext: valid, customerText: "怀孕了价格多少?" },
    { metaAdContext: valid, conversationHistory: [
      { role: "user", content: "之前想了解9D" },
      { role: "user", content: "地址?" },
      { role: "user", content: "价格?" },
    ] },
    { metaAdContext: valid, conversationHistory: [
      { role: "user", content: "我想改聊别的事情" },
      { role: "user", content: "价格?" },
    ] },
    { metaAdContext: valid, conversationHistory: [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "[Verified STAFF message] 我来帮你" },
      { role: "user", content: "价格?" },
    ] },
    { metaAdContext: valid, conversationHistory: [
      ...Array.from({ length: 5 }, () => ({ role: "user", content: "你好" })),
      { role: "user", content: "价格?" },
    ] },
  ];
  for (const condition of conditions) {
    assert.equal(decide(condition), null, JSON.stringify(condition));
  }
});

test("price image remains independently gated by ownership, receipt and reply success", async () => {
  const metaAdContext = context("小颜术 6");
  const decision = decide({ metaAdContext });
  assert.equal(decision?.source, "meta_ad");
  assert.equal(await promotionFor(decision, "价格?",
    [{ role: "user", content: "价格?" }], { needsAttention: true }), null);
  assert.equal(await promotionFor(decision, "价格?",
    [{ role: "user", content: "价格?" }], { textSendSucceeded: false }), null);
  assert.equal(await promotionFor(decision, "价格?",
    [{ role: "user", content: "价格?" }], { hasUnconfirmedMediaDelivery: async () => true }), null);
  assert.equal(await promotionFor(decision, "价格?",
    [{ role: "user", content: "价格?" }], { wasPromoRecentlySent: async () => true }), null);
});
