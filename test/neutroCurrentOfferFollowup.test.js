"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  currentOfferRequestText, isCurrentOfferEnquiry, resolveCurrentOfferService,
} = require("../src/utils/currentOfferEnquiry");
const { resolveShadowPriceException } = require("../src/utils/shadowPriceException");
const { resolveAiPricingDecision } = require("../src/utils/aiPricingIntentDecision");
const { resolveApprovedPricingAssessment } = require("../src/utils/approvedPricingDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const now = Date.now();
const services = [{ name: "3D 小颜术" }, { name: "9D 逆龄抗衰" },
  { name: "骨盆调理" }];
const serviceAliases = [
  { alias: "3D", officialService: "3D 小颜术" },
  { alias: "9D", officialService: "9D 逆龄抗衰" },
  { alias: "骨盆", officialService: "骨盆调理" },
];
const promotions = [
  { name: "3D 小颜术 First Trial", linkedService: "3D 小颜术",
    sendOnPriceQuery: true, validFrom: "2000-01-01",
    validUntil: "2999-12-31", imageUrl: "https://example.test/3d.jpg",
    caption: "3D First Trial 现在只需 RM388（原价 RM888）",
    pricing: { currency: "MYR", normal: 888, offer: 388 } },
  { name: "9D 逆龄抗衰 First Trial", linkedService: "9D 逆龄抗衰",
    sendOnPriceQuery: true, validFrom: "2000-01-01",
    validUntil: "2999-12-31", imageUrl: "https://example.test/9d.jpg",
    caption: "9D First Trial 现在只需 RM488（原价 RM1288）",
    pricing: { currency: "MYR", normal: 1288, offer: 488 } },
  { name: "骨盆调理套餐", linkedService: "骨盆调理",
    sendOnPriceQuery: true, validFrom: "2000-01-01",
    validUntil: "2999-12-31",
    packages: [
      { name: "Package A", imageUrl: "https://example.test/a.jpg",
        caption: "Package A 现在只需 RM388（原价 RM488）",
        pricing: { currency: "MYR", offer: 388, normal: 488 } },
      { name: "Package B", imageUrl: "https://example.test/b.jpg",
        caption: "Package B 现在只需 RM288（原价 RM388）",
        pricing: { currency: "MYR", offer: 288, normal: 388 } },
    ] },
];
const h = (role, content, age, staff = false) => ({
  role, content, pricingCreatedAtMs: now - age, pricingStaffAuthored: staff,
});
const conversation = (question, age = 8 * 60 * 60 * 1000) => [
  h("user", "我想了解3D小颜术", age),
  h("assistant", "3D小颜术是一项徒手面部轮廓护理", age - 30000),
  h("user", question, 1000),
];
const opts = (customerText, conversationHistory, extra = {}) => ({
  customerText, conversationHistory, services, serviceAliases, promotions,
  allowOfferEnquiries: true, now, ...extra,
});
const approve = (mode, decision, customerText, history) =>
  resolveApprovedPricingAssessment({
    mode, shadowException: mode === "shadow" ? decision : null,
    aiDecision: mode === "enabled" ? decision : null,
    customerText, conversationHistory: history, services, serviceAliases,
    allowOfferEnquiries: true, resultMedia: [], now,
  });

async function simulateSecondaryPricingFlow({
  text, history, modelOfferQuery = false, textAccepted = true,
  duplicate = false, unknownReceipt = false,
} = {}) {
  // Real production decision, verified text formatter and promo selector.
  // Only the provider/queue effects are faked; no customer or Meta calls.
  const d = resolveShadowPriceException(opts(text, history, { modelOfferQuery }));
  const approval = approve("shadow", d, text, history);
  if (!approval.decision) return { approval, events: [] };
  const quoted = ensureVerifiedPriceReply({
    customerText: text, conversationHistory: history,
    treatment: approval.decision.treatment,
    pricingDecision: approval.decision,
    reply: "好的，我们继续聊 😊",
    priceOnlyResponse: true, services, serviceAliases, promotions,
    language: "zh",
  });
  const events = [];
  if (textAccepted) events.push({ kind: "text", reply: quoted.reply });
  const bundle = await resolvePricePromotionForReply({
    customerText: text, conversationHistory: history, promotions,
    services, serviceAliases, resultMedia: [], contactId: 9170,
    pricingDecision: approval.decision, aiPricingEnabled: true,
    treatment: approval.decision.treatment,
    verifiedServiceFromText: approval.decision.treatment,
    verifiedShadowPriceService: approval.decision.treatment,
    flagged: false, bookingReady: false, needsAttention: false,
    keywordReason: null, textSendSucceeded: textAccepted,
    wasPromoRecentlySent: async () => duplicate,
    hasUnconfirmedMediaDelivery: async () => unknownReceipt,
    language: "zh", now: new Date(now),
  });
  // This is the real queue item's input contract, without external sends.
  if (bundle) {
    const queued = { kind: "promotion", solicitedPricing:
      approval.decision.type === "price", items: bundle.packages.map(p => ({
        imageUrl: p.imageUrl, caption: p.caption,
      })) };
    events.push({ kind: "queued", value: queued });
  }
  return { approval, events };
}

test("natural newcomer enquiries use AI intent plus independently verified offer wording", () => {
  for (const text of ["现在有什么体验活动？", "有新客福利吗？",
    "近期有什么特别体验活动呢？"]) {
    assert.equal(isCurrentOfferEnquiry(text, { modelOfferQuery: true }), true, text);
    const hist = conversation(text);
    const shadow = resolveShadowPriceException(opts(text, hist, {
      modelOfferQuery: true,
    }));
    assert.equal(shadow?.treatment, "3D 小颜术", text);
    const enabled = resolveAiPricingDecision(opts(text, hist, {
      packageQuery: true, priceQuery: false, treatment: "9D 逆龄抗衰",
    }));
    assert.equal(enabled?.treatment, "3D 小颜术", text);
    assert.equal(approve("shadow", shadow, text, hist).reason, "approved", text);
  }
});

test("current First Trial and later promotional permission remain separate", async () => {
  const text = "现在有first try优惠吗？以后有优惠也发我看看 😊";
  assert.equal(currentOfferRequestText(text), "现在有first try优惠吗");
  const hist = conversation(text);
  const d = resolveShadowPriceException(opts(text, hist));
  assert.equal(d?.treatment, "3D 小颜术");
  assert.deepEqual(d.prices.map(x => x.price), ["RM388"]);
  const ai = resolveAiPricingDecision(opts(text, hist, {
    packageQuery: true, priceQuery: false,
  }));
  assert.equal(ai?.treatment, "3D 小颜术");
  assert.equal(approve("enabled", ai, text, hist).reason, "approved");
  const flow = await simulateSecondaryPricingFlow({ text, history: hist });
  assert.equal(flow.approval.reason, "approved");
  assert.deepEqual(flow.events.map(x => x.kind), ["text", "queued"]);
  assert.match(flow.events[0].reply, /RM388/);
  assert.deepEqual(flow.events[1].value.items.map(x => x.imageUrl),
    ["https://example.test/3d.jpg"]);
  assert.equal(flow.events[1].value.solicitedPricing, true);
});

test("verified treatment remains available after eight hours but not after 24 hours", () => {
  const text = "优惠";
  assert.equal(resolveCurrentOfferService(opts(text, conversation(text)))?.name,
    "3D 小颜术");
  assert.equal(resolveShadowPriceException(opts(text, conversation(text)))?.treatment,
    "3D 小颜术");
  assert.equal(resolveCurrentOfferService(opts(text, conversation(text, 25 * 60 * 60 * 1000))),
    null);
});

test("future consent, comments, budget and clinical changes do not authorize pricing images", async () => {
  for (const text of [
    "以后有优惠也发我看看",
    "有优惠再通知我",
    "我已经看过优惠了",
    "优惠很好，谢谢",
    "多少钱对我来说不重要",
    "现在我只是想知道体验多久",
    "怀孕了有优惠吗",
    "新客做一次要多久",
  ]) {
    assert.equal(isCurrentOfferEnquiry(text, { modelOfferQuery: true }),
      false, text);
    const result = await simulateSecondaryPricingFlow({
      text, history: conversation(text), modelOfferQuery: true,
    });
    assert.equal(result.events.length, 0, text);
  }
});

test("staff ownership, conflicting treatments and an unverified ad cannot resurrect an offer", () => {
  const text = "有新客福利吗？";
  const staff = [
    h("user", "我想了解3D小颜术", 180000),
    h("assistant", "3D小颜术", 170000),
    h("assistant", "[Verified STAFF message] 已经回复你", 120000, true),
    h("user", text, 1000),
  ];
  assert.equal(resolveCurrentOfferService(opts(text, staff, {
    modelOfferQuery: true,
  })), null);
  const both = [
    h("user", "我想了解3D和9D", 180000),
    h("assistant", "3D和9D都可以了解", 170000),
    h("user", text, 1000),
  ];
  assert.equal(resolveCurrentOfferService(opts(text, both, {
    modelOfferQuery: true,
  })), null);
  assert.equal(resolveCurrentOfferService(opts(text, [
    h("assistant", "3D小颜术有优惠", 140000),
    h("user", text, 1000),
  ], { modelOfferQuery: true })), null);
});

test("actual pricing decision controls text and graphical queue eligibility", async () => {
  const text = "现在有什么体验活动？";
  const history = conversation(text);
  const defaults = { text, history, modelOfferQuery: true };
  const accepted = await simulateSecondaryPricingFlow(defaults);
  assert.deepEqual(accepted.events.map(e => e.kind), ["text", "queued"]);
  assert.deepEqual(accepted.events[1].value.items.map(e => e.imageUrl),
    ["https://example.test/3d.jpg"]);
  assert.equal((await simulateSecondaryPricingFlow({
    ...defaults, textAccepted: false,
  })).events.length, 0, "rejected text must not schedule the graphic");
  assert.deepEqual((await simulateSecondaryPricingFlow({
    ...defaults, duplicate: true,
  })).events.map(e => e.kind), ["text"], "no duplicate images");
  assert.deepEqual((await simulateSecondaryPricingFlow({
    ...defaults, unknownReceipt: true,
  })).events.map(e => e.kind), ["text"], "no retry on uncertain receipt");
});
