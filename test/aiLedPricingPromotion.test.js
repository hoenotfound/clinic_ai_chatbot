"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { resolveAiPricingIntent } = require("../src/utils/aiPricingIntentDecision");
const { ensureVerifiedPriceReply, verifiedPricesForService } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { guardAssessmentFirstPricingReply } = require("../src/utils/initialOfferReplyGuard");
const { parseAiReplyResult } = require("../src/utils/aiReplyResult");

const services = [{ name: "3D 小颜术" }, { name: "9D 逆龄抗衰" }, { name: "骨盆调理" }];
const aliases = [
  { alias: "3D", officialService: "3D 小颜术" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
  { alias: "骨盆", officialService: "骨盆调理" },
];
const promotion = {
  name: "3D First Trial",
  linkedService: "3D 小颜术",
  sendOnPriceQuery: true,
  imageUrl: "https://example.test/promo/32",
  caption: "限时优惠 First Trial",
  followUpMessage: "3D First Trial 只需 RM 4️⃣8️⃣8️⃣ (原价 RM888)",
  pricing: { currency: "MYR", offer: 488, normal: 888 },
};
const history = [
  { role: "user", content: "Hi～想了解 Neutro Sense TCM 3D 小颜术，可以 WhatsApp 跟进我和发相关优惠～" },
  { role: "assistant", content: "3D小颜术是我们的徒手脸型护理。" },
  { role: "assistant", content: "这个是顾客完成一次3D小颜术后的 Before & After。" },
  { role: "user", content: "请问,做一次多少" },
];
function decision(overrides = {}) {
  return resolveAiPricingIntent({
    intent: { type: "price", treatment: "3D 小颜术", source: "recent_customer" },
    customerText: "请问,做一次多少",
    conversationHistory: history,
    services, serviceAliases: aliases,
    ...overrides,
  });
}
async function withAssessmentFirst(fn) {
  const previous = config.automatedFollowUp;
  config.automatedFollowUp = { ...previous, assessmentFirstPricingEnabled: true };
  try { return await fn(); }
  finally { config.automatedFollowUp = previous; }
}

test("structured reply parser retains AI pricing intent without changing priceQuery", () => {
  const raw = JSON.stringify({
    reply: "First Trial details",
    outcome: "normal", serviceQuery: true, serviceQuerySource: "conversation",
    priceQuery: false, packageQuery: false,
    pricingIntent: { type: "price", treatment: "3D 小颜术", source: "recent_customer" },
  });
  const result = parseAiReplyResult(raw);
  assert.equal(result.pricingIntent.type, "price");
  assert.equal(result.pricingIntent.treatment, "3D 小颜术");
  assert.equal(result.priceQuery, false);
});

test("Ms's real follow-up is a verified contextual 3D price request", () => {
  assert.deepEqual(decision(), {
    type: "price", treatment: "3D 小颜术", source: "recent_customer",
  });
});

test("AI pricing decision does not authorize a guessed, unrelated, or ambiguous service", () => {
  assert.equal(decision({ intent: { type: "price", treatment: "9D 逆龄抗衰", source: "recent_customer" } }), null);
  assert.equal(decision({ intent: { type: "price", treatment: "3D 小颜术", source: "meta_ad" } }), null);
  assert.equal(decision({ customerText: "3D 和 9D 哪个多少钱？" }), null);
  assert.equal(decision({
    conversationHistory: [
      { role: "user", content: "我想了解3D小颜术" },
      { role: "assistant", content: "[Verified STAFF message] 先沟通一下" },
      { role: "user", content: "请问,做一次多少" },
    ],
  }), null);
  assert.equal(decision({
    conversationHistory: [
      { role: "user", content: "我想了解3D小颜术" },
      { role: "user", content: "我想改聊其他事情" },
      { role: "user", content: "请问,做一次多少" },
    ],
  }), null);
});

test("future follow-up permission, medical concerns, and free-assessment fee do not send price graphics", () => {
  assert.equal(decision({
    customerText: "想了解3D小颜术，可以 WhatsApp 跟进我和发相关优惠",
    intent: { type: "price", treatment: "3D 小颜术", source: "current_customer" },
  }), null);
  assert.equal(decision({ customerText: "怀孕了做一次多少" }), null);
  assert.equal(decision({
    customerText: "你们免费1对1评估多少钱",
    complimentaryAssessmentExperienceEnabled: true,
  }), null);
});

test("package offers remain off unless the clinic explicitly opts in", () => {
  const intent = { type: "package_options", treatment: "3D 小颜术", source: "recent_customer" };
  assert.equal(decision({ intent }), null);
  assert.equal(decision({ intent, allowOfferEnquiries: true }).type, "package_options");
});

test("numeric offer amounts remain authoritative, with conflicting price copy blocked", () => {
  assert.equal(verifiedPricesForService("3D 小颜术", [promotion])[0].price, "RM488");
  const bad = { ...promotion, followUpMessage: "现在只需 RM588" };
  assert.equal(verifiedPricesForService("3D 小颜术", [bad]), null);
});

test("one verified decision governs both price text and optional graphic", async () => {
  await withAssessmentFirst(async () => {
    const ai = decision();
    assert.ok(ai);
    const guarded = guardAssessmentFirstPricingReply({
      customerText: "请问,做一次多少", reply: "这项疗程 RM488",
      treatment: ai.treatment, verifiedPricingIntent: true,
      requireVerifiedTreatment: true, services, serviceAliases: aliases,
      conversationHistory: history, resultMedia: [],
    });
    assert.equal(guarded.replaced, false);
    const text = ensureVerifiedPriceReply({
      customerText: "请问,做一次多少", reply: "我们有优惠我发你",
      treatment: ai.treatment, verifiedPricingIntent: true,
      services, serviceAliases: aliases, promotions: [promotion],
      conversationHistory: history, resultMedia: [], language: "zh",
    });
    assert.match(text.reply, /RM488/);
    const shared = {
      customerText: "请问,做一次多少", conversationHistory: history,
      priceQuery: false, packageQuery: false,
      treatment: ai.treatment, verifiedServiceFromText: ai.treatment,
      verifiedPricingIntent: true, aiPricingEnabled: true,
      flagged: false, bookingReady: false, keywordReason: null, needsAttention: false,
      textSendSucceeded: true, promotions: [promotion],
      services, serviceAliases: aliases, resultMedia: [],
      contactId: 484, language: "zh",
      wasPromoRecentlySent: async () => false,
      hasUnconfirmedMediaDelivery: async () => false,
    };
    const media = await resolvePricePromotionForReply(shared);
    assert.equal(media?.packages[0]?.imageUrl, promotion.imageUrl);
    assert.equal(await resolvePricePromotionForReply({
      ...shared, wasPromoRecentlySent: async () => true,
    }), null, "manually sent graphic must not be repeated");
    assert.equal(await resolvePricePromotionForReply({
      ...shared, hasUnconfirmedMediaDelivery: async () => true,
    }), null, "unknown Meta receipt must never be blindly resent");
    assert.equal(await resolvePricePromotionForReply({
      ...shared, textSendSucceeded: false,
    }), null, "a failed initial text must not create an independent media send");
    assert.equal(await resolvePricePromotionForReply({
      ...shared, verifiedPricingIntent: false,
    }), null, "AI pricing classification alone is not enough");
  });
});
