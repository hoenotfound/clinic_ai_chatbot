"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeMetaAdReplyContext } = require("../src/services/metaAdReplyContextService");
const { resolveAiPricingDecision } = require("../src/utils/aiPricingIntentDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const TEST_NOW = Date.parse("2026-10-16T12:00:00.000Z");

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

function context(adName, headline = "欢迎了解", attributedAt = TEST_NOW) {
  return normalizeMetaAdReplyContext({
    source: "meta_ads", ad_name: adName, headline, body: "",
    attributed_at: attributedAt,
  }, { services, aliases: serviceAliases });
}

function decide({ customerText = "价格?", conversationHistory, metaAdContext,
  treatment = null, priceQuery = true, ...overrides } = {}) {
  return resolveAiPricingDecision({
    priceQuery, treatment, customerText,
    conversationHistory: conversationHistory ||
      [{ role: "user", content: customerText }],
    metaAdContext, services, serviceAliases, promotions,
    now: TEST_NOW, ...overrides,
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
    { metaAdContext: valid, customerText: "订金多少钱?" },
    { metaAdContext: valid, customerText: "定金要多少钱?" },
    { metaAdContext: valid, customerText: "注册费多少钱?" },
    { metaAdContext: valid, customerText: "deposit how much?" },
    { metaAdContext: valid, customerText: "3D 小颜术订金多少钱?" },
    { metaAdContext: valid, customerText: "3D 小颜术咨询费多少钱?" },
    { metaAdContext: valid, customerText: "how much for parking?" },
    { metaAdContext: valid, customerText: "多少钱的consultation?" },
    { metaAdContext: valid, customerText: "押金多少钱?" },
    { metaAdContext: valid, customerText: "how much would you charge for delivery?" },
    { metaAdContext: valid, customerText: "价格高不高?" },
    { metaAdContext: valid, customerText: "做多少次才有效?" },
    { metaAdContext: valid, customerText: "全部疗程价格?" },
    { metaAdContext: valid, customerText: "停车费多少钱?" },
    { metaAdContext: valid, customerText: "有优惠可以发我" },
    { metaAdContext: valid, customerText: "免费评估多少钱?",
      complimentaryAssessmentExperienceEnabled: true },
    { metaAdContext: valid, customerText: "怀孕了价格多少?" },
    { metaAdContext: { ...valid, attributedAt: undefined } },
    { metaAdContext: context("小颜术 6", "欢迎了解", TEST_NOW - 8 * 24 * 60 * 60 * 1000) },
    { metaAdContext: context("小颜术 6", "欢迎了解", TEST_NOW + 60 * 1000) },
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


test("verified ad price overrides a model-only service guess, but never a customer switch", () => {
  const metaAdContext = context("小颜术 6");
  const priceOnly = [{ role: "user", content: "价格?" }];
  const decision = decide({
    metaAdContext, customerText: "价格?",
    conversationHistory: priceOnly, treatment: "9D 逆龄抗衰",
  });
  assert.equal(decision?.source, "meta_ad");
  assert.equal(decision?.treatment, "3D 小颜术");

  const changed = [
    { role: "user", content: "现在想了解骨盆调理" },
    { role: "assistant", content: "骨盆调理可以先做评估" },
    { role: "user", content: "价格?" },
  ];
  assert.equal(decide({ metaAdContext, conversationHistory: changed,
    customerText: "价格?", treatment: "3D 小颜术" }), null);
});

test("ad-only treatment price wording remains narrow and current", () => {
  const metaAdContext = context("小颜术 6");
  for (const customerText of [
    "价格?", "多少钱?", "做一次多少钱?", "请问做一次多少钱?",
    "How much?", "How much for one session?", "berapa satu sesi?",
  ]) {
    const d = decide({ metaAdContext, customerText,
      conversationHistory: [{ role: "user", content: customerText }],
      priceQuery: true });
    assert.equal(d?.treatment, "3D 小颜术", customerText);
    assert.equal(d?.prices?.[0]?.price, "RM488", customerText);
  }
  const miss = decide({ metaAdContext, customerText: "做一次多少钱?",
    priceQuery: false });
  assert.equal(miss?.treatment, "3D 小颜术");
});

test("Neutro production-shaped emoji price translations are verified against numerical MYR values", async () => {
  // Shape and price wording mirror the October Neutro 3D promotion; no
  // customer data, credentials, Meta URLs or private media links in this test.
  const realistic = {
    ...promotions[0], name: "3D 小颜术 First Trial",
    caption: "【中医小颜术】是一项中医的治疗项目",
    followUpMessage: "🎊 限时优惠 小颜术美颜整骨 💎只需 RM 4️⃣8️⃣8️⃣ ( 原价 RM888)",
    mediaTranslations: {
      en: { caption: "TCM Face Sculpting care" },
      ms: { caption: "Rawatan TCM" },
      zh: { caption: "中医小颜术护理" },
    },
    followUpTranslations: {
      en: "Limited-time offer RM 4️⃣8️⃣8️⃣ (Original price RM888)",
      ms: "Promosi masa terhad RM 4️⃣8️⃣8️⃣ (Harga asal RM888)",
      zh: "限时优惠 💎RM 4️⃣8️⃣8️⃣ (原价 RM888)",
    },
  };
  const metaAdContext = context("小颜术 6");
  const d = decide({ metaAdContext, promotions: [realistic] });
  assert.equal(d?.treatment, "3D 小颜术");
  assert.deepEqual(d?.prices?.map(p => p.price), ["RM488"]);
  const graphic = await promotionFor(d, "价格?",
    [{ role: "user", content: "价格?" }], { promotions: [realistic] });
  assert.equal(graphic?.packages?.[0]?.imageUrl, "https://example.test/3d.png");

  const mismatch = structuredClone(realistic);
  mismatch.followUpTranslations.en = "Limited-time offer RM 999 (Original price RM888)";
  assert.equal(decide({ metaAdContext, promotions: [mismatch] })?.prices, null);
  const wrongNormal = structuredClone(realistic);
  wrongNormal.followUpTranslations.en = "Limited-time offer RM 4️⃣8️⃣8️⃣ (Original price RM999)";
  assert.equal(decide({ metaAdContext, promotions: [wrongNormal] })?.prices, null);
});

test("asking for a 3D treatment price and booking in the same message still works", () => {
  const text = "3D 小颜术做一次多少钱？可以预约吗";
  const d = decide({
    customerText: text,
    conversationHistory: [{ role: "user", content: text }],
    metaAdContext: context("小颜术 6"),
  });
  assert.equal(d?.treatment, "3D 小颜术");
  assert.equal(d?.source, "current_customer");
  assert.deepEqual(d?.prices?.map(p => p.price), ["RM488"]);
});
