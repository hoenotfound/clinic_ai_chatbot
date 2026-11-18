"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { isCurrentOfferEnquiry, resolveCurrentOfferService } =
  require("../src/utils/currentOfferEnquiry");
const { resolveShadowPriceException } = require("../src/utils/shadowPriceException");
const { resolveAiPricingDecision, hasCustomerRequestedPriceReply } =
  require("../src/utils/aiPricingIntentDecision");
const { resolveApprovedPricingAssessment } =
  require("../src/utils/approvedPricingDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { guardAssessmentFirstPricingReply } =
  require("../src/utils/initialOfferReplyGuard");

const now = Date.now();
const services = [{ name: "3D 小颜术" }, { name: "9D 逆龄抗衰" },
  { name: "骨盆调理" }];
const serviceAliases = [
  { alias: "3D", officialService: "3D 小颜术" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
  { alias: "骨盆", officialService: "骨盆调理" },
];
const promotions = [
  {
    name: "3D 小颜术 First Trial", linkedService: "3D 小颜术",
    sendOnPriceQuery: true, validFrom: "2000-01-01",
    validUntil: "2999-12-31", imageUrl: "https://example.test/3d.jpg",
    caption: "3D 小颜术 First Trial 现在只需 RM388（原价 RM888）",
    pricing: { offer: 388, normal: 888, currency: "MYR" },
  },
  {
    name: "9D 逆龄抗衰 First Trial", linkedService: "9D 逆龄抗衰",
    sendOnPriceQuery: true, validFrom: "2000-01-01",
    validUntil: "2999-12-31", imageUrl: "https://example.test/9d.jpg",
    caption: "9D 逆龄抗衰 First Trial 现在只需 RM488（原价 RM1288）",
    pricing: { offer: 488, normal: 1288, currency: "MYR" },
  },
  {
    name: "骨盆调理套餐", linkedService: "骨盆调理",
    sendOnPriceQuery: true, validFrom: "2000-01-01",
    validUntil: "2999-12-31",
    packages: [
      { name: "Package A", imageUrl: "https://example.test/a.jpg",
        caption: "骨盆 Package A 现在只需 RM388（原价 RM488）",
        pricing: { offer: 388, normal: 488, currency: "MYR" } },
      { name: "Package B", imageUrl: "https://example.test/b.jpg",
        caption: "骨盆 Package B 现在只需 RM288（原价 RM388）",
        pricing: { offer: 288, normal: 388, currency: "MYR" } },
    ],
  },
];
const t = (role, content, age, staff = false) =>
  ({ role, content, pricingCreatedAtMs: now - age, pricingStaffAuthored: staff });
const first = "Hi～想了解 Neutro Sense TCM 3D 小颜术，可以 WhatsApp 跟进我和发相关优惠～";
const question = "都有。\n你们有first try优惠吗？";
const originalHistory = () => [
  t("user", first, 240000),
  t("assistant", "Hi～欢迎来到 Neutro Sense，你是对我们的 3D 小颜术有兴趣对吗？", 239000),
  t("assistant", "3D小颜术完成一次的 Before & After", 238000),
  t("user", "整体脸型轮廓，紧致", 145000),
  t("assistant", "3D小颜术主要是徒手针对脸型轮廓和肌肉张力调整", 140000),
  t("user", question, 60000),
];
const repeatHistory = () => [
  ...originalHistory(),
  t("assistant", "好的，我们继续聊3D 小颜术 😊 你想进一步确认哪一部分呢？", 57000),
  t("user", "优惠", 1000),
];
const opts = (customerText, conversationHistory, extra = {}) => ({
  customerText, conversationHistory, services, serviceAliases,
  promotions, allowOfferEnquiries: true, now, ...extra,
});
function approve(decision, customerText, conversationHistory, mode = "shadow") {
  return resolveApprovedPricingAssessment({
    mode, shadowException: mode === "shadow" ? decision : null,
    aiDecision: mode === "enabled" ? decision : null,
    customerText, conversationHistory, services, serviceAliases,
    resultMedia: [], allowOfferEnquiries: true, now,
  });
}
async function images(decision, customerText, conversationHistory, extra = {}) {
  return resolvePricePromotionForReply({
    aiPricingEnabled: true, pricingDecision: decision, priceQuery: true,
    packageQuery: true, treatment: decision?.treatment || null,
    verifiedServiceFromText: decision?.treatment || null,
    verifiedShadowPriceService: decision?.treatment || null,
    customerText, conversationHistory, promotions, services, serviceAliases,
    resultMedia: [], flagged: false, bookingReady: false, keywordReason: null,
    needsAttention: false, textSendSucceeded: true, contactId: 9170,
    language: "zh", wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false, ...extra,
  });
}

test("9170: First Trial enquiry after 3D discussion authorizes correct price and graphic in Shadow", async () => {
  const history = originalHistory();
  assert.equal(isCurrentOfferEnquiry(question), true);
  assert.equal(resolveCurrentOfferService(opts(question, history))?.name, "3D 小颜术");
  const decision = resolveShadowPriceException(opts(question, history));
  assert.equal(decision?.source, "customer_current_offer");
  assert.equal(decision?.treatment, "3D 小颜术");
  assert.deepEqual(decision?.prices.map(p => p.price), ["RM388"]);
  assert.equal(approve(decision, question, history).reason, "approved");
  const graphic = await images(decision, question, history);
  assert.deepEqual(graphic?.packages.map(p => p.imageUrl), ["https://example.test/3d.jpg"]);
  const quote = ensureVerifiedPriceReply({
    customerText: question, conversationHistory: history,
    reply: "好的，我们继续聊3D 小颜术 😊 你想进一步确认哪一部分呢？",
    treatment: decision.treatment, pricingDecision: decision,
    promotions, services, serviceAliases, language: "zh", priceOnlyResponse: true,
  });
  assert.equal(quote.restored, true);
  assert.match(quote.reply, /First Trial.*RM388/su);
  assert.match(quote.reply, /想了解优惠包含什么/u);
  assert.doesNotMatch(quote.reply, /我们继续聊|想进一步确认哪一部分/u);
});

test("9170: standalone 优惠 continues prior verified 3D, rather than repeating a question", async () => {
  const history = repeatHistory();
  const decision = resolveShadowPriceException(opts("优惠", history));
  assert.equal(decision?.treatment, "3D 小颜术");
  assert.equal(approve(decision, "优惠", history).reason, "approved");
  const guarded = guardAssessmentFirstPricingReply({
    customerText: "优惠", reply: "优惠价 RM388", treatment: decision.treatment,
    verifiedPricingIntent: true, conversationHistory: history,
    services, serviceAliases, promotions, isFirstMessage: false,
  });
  assert.equal(guarded.replaced, false);
  assert.equal((await images(decision, "优惠", history))?.packages.length, 1);
});

test("Enabled mode uses same verified promotion for text and media, even when model misses price intent", async () => {
  const history = repeatHistory();
  const decision = resolveAiPricingDecision(opts("优惠", history, {
    priceQuery: false, packageQuery: false, treatment: "9D 逆龄抗衰",
  }));
  assert.equal(decision?.source, "customer_current_offer");
  assert.equal(decision?.treatment, "3D 小颜术");
  assert.equal(approve(decision, "优惠", history, "enabled").reason, "approved");
  assert.equal(hasCustomerRequestedPriceReply({
    customerText: "优惠", pricingDecision: decision,
  }), true);
  assert.equal((await images(decision, "优惠", history))?.packages[0]?.name, "Main offer");
});

test("current named treatment is authoritative, not a stale model or ad guess", () => {
  const history = [t("user", "9D逆龄抗衰现在有优惠吗？", 1000)];
  const decision = resolveAiPricingDecision(opts(history[0].content, history, {
    priceQuery: false, treatment: "3D 小颜术",
  }));
  assert.equal(decision?.treatment, "9D 逆龄抗衰");
  assert.deepEqual(decision?.prices.map(p => p.price), ["RM488"]);
});

test("pelvic current-offer enquiry preserves both Package A and B graphics", async () => {
  const history = [
    t("user", "我想了解骨盆调理", 110000),
    t("assistant", "骨盆调理主要是徒手护理", 108000),
    t("user", "有优惠吗？", 1000),
  ];
  const decision = resolveShadowPriceException(opts("有优惠吗？", history));
  assert.equal(decision?.treatment, "骨盆调理");
  assert.deepEqual(decision?.prices.map(p => p.price), ["RM388","RM288"]);
  assert.deepEqual((await images(decision, "有优惠吗？", history))?.packages.map(p => p.name),
    ["Package A","Package B"]);
});

test("current pelvic package options get both images even if AI missed the package flag", async () => {
  const customerText = "骨盆有什么配套？";
  const history = [
    t("user", "我想了解骨盆调理", 110000),
    t("assistant", "骨盆调理可以先做体态评估", 107000),
    t("user", customerText, 1000),
  ];
  assert.equal(isCurrentOfferEnquiry(customerText), true);
  const shadow = resolveShadowPriceException(opts(customerText, history));
  assert.equal(shadow?.treatment, "骨盆调理");
  assert.deepEqual((await images(shadow, customerText, history))?.packages.map(p => p.name),
    ["Package A", "Package B"]);
  const enabled = resolveAiPricingDecision(opts(customerText, history, {
    priceQuery: false, packageQuery: false, treatment: "3D 小颜术",
  }));
  assert.equal(enabled?.type, "package_options");
  assert.equal(enabled?.treatment, "骨盆调理");
  assert.equal(approve(enabled, customerText, history, "enabled").reason, "approved");
  assert.deepEqual((await images(enabled, customerText, history))?.packages.map(p => p.name),
    ["Package A", "Package B"]);
});

test("compound treatment duration plus current First Trial request is not rejected as non-price-only", () => {
  const customerText = "3D做多久？有first try优惠吗？";
  const history = [
    t("user", "想了解3D小颜术", 100000),
    t("assistant", "3D小颜术可以安排面部评估", 99000),
    t("user", customerText, 1000),
  ];
  const enabled = resolveAiPricingDecision(opts(customerText, history, {
    priceQuery: true, packageQuery: false,
  }));
  assert.equal(enabled?.treatment, "3D 小颜术");
  assert.equal(approve(enabled, customerText, history, "enabled").reason, "approved");
});

test("duplicate graphic or unresolved provider receipt does not trigger another image", async () => {
  const history = originalHistory();
  const decision = resolveShadowPriceException(opts(question, history));
  assert.equal(await images(decision, question, history, {
    wasPromoRecentlySent: async () => true,
  }), null);
  assert.equal(await images(decision, question, history, {
    hasUnconfirmedMediaDelivery: async () => true,
  }), null);
});

test("future promotional consent and acknowledgements are not current quote requests", () => {
  const history = [
    t("user", first, 110000),
    t("assistant", "3D小颜术主要针对脸型", 105000),
  ];
  for (const text of [
    first, "有优惠也发我看看 😊", "以后有优惠发给我",
    "下个月有优惠吗？", "我已经看过优惠了",
    "优惠很不错", "不用发优惠", "3D需要做多久？",
    "我预算RM300", "你们的优惠很贵",
  ]) {
    assert.equal(isCurrentOfferEnquiry(text), false, text);
    const turns = [...history, t("user", text, 1000)];
    assert.equal(resolveShadowPriceException(opts(text, turns)), null, text);
  }
});

test("no customer service, clinical/staff intervention, stale context and ambiguous topics fail closed", () => {
  const base = originalHistory();
  const cases = [
    [t("assistant", "3D很好", 2000), t("user", "优惠", 1000)],
    [...base.slice(0,-1), t("assistant", "[Verified STAFF message] 我会回复你", 2000, true), t("user", "优惠", 1000)],
    [t("user", "我想了解3D小颜术", 4*60*60*1000),
      t("assistant", "3D小颜术很适合了解", 4*60*60*1000-1000),
      t("user", "优惠", 1000)],
    [t("user", "想了解3D和9D", 100000),
      t("assistant", "3D和9D都有护理", 98000), t("user", "优惠", 1000)],
    [t("user", "想了解3D小颜术", 100000),
      t("assistant", "3D小颜术", 99000),
      t("user", "另外想问其他疗程", 90000),
      t("user", "优惠", 1000)],
    [t("user", "想了解3D小颜术", 100000),
      t("assistant", "3D小颜术", 99000),
      t("user", "我怀孕了可以做吗", 90000),
      t("user", "优惠", 1000)],
  ];
  for (const turns of cases) {
    assert.equal(resolveCurrentOfferService(opts("优惠", turns)), null);
  }
  assert.equal(resolveCurrentOfferService(opts("优惠", [
    t("user", "优惠", 1000),
  ])), null);
});
