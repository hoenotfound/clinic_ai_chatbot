"use strict";

// Regression for Neutro Sense contact #613 on 20 October 2026.
// A normal fee enquiry was falsely classified as clinical because 用
// inside 费用 matched the bare treatment-use verb.
const test = require("node:test");
const assert = require("node:assert/strict");
const { hasClinicalMediaRisk } = require("../src/utils/aiReviewPolicy");
const { resolveShadowPriceException } = require("../src/utils/shadowPriceException");
const { resolveApprovedPricingAssessment } = require("../src/utils/approvedPricingDecision");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const services = [
  { name: "骨盆调理" }, { name: "3D 小颜术" }, { name: "产后调理" },
];
const serviceAliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "骨盆调整", officialService: "骨盆调理" },
  { alias: "盆骨", officialService: "骨盆调理" },
  { alias: "产后", officialService: "产后调理" },
];
const promotions = [{
  name: "骨盆调理套餐", linkedService: "骨盆调理", sendOnPriceQuery: true,
  packages: [
    { name: "Package A", imageUrl: "https://example.test/pelvic-a.jpg",
      caption: "本月限时优惠 现在只需 RM388",
      pricing: { currency: "MYR", offer: 388, normal: 488 } },
    { name: "Package B", imageUrl: "https://example.test/pelvic-b.jpg",
      caption: "本月限时优惠 现在只需 RM288",
      pricing: { currency: "MYR", offer: 288, normal: 388 } },
  ],
}];
const config = { services, serviceAliases, promotions, resultMedia: [] };
const originalFee = "小腹突出。。 可以知道调理一次的费用吗？";
const clarification = "请问你想了解哪一项疗程的价格呢？我可以帮你确认 😊";
const selectedService = "调整骨盆";

function transcript(now) {
  const turn = (role, content, secondsAgo) => ({
    role, content, pricingCreatedAtMs: now - 1000 * secondsAgo,
  });
  const initial = [
    turn("user",
      "Hi～我对 Neutro Sense TCM 骨盆调理有兴趣，可以跟进我，有优惠也发我看看 😊", 190),
    turn("assistant", "我们的骨盆调理主要是中医师用徒手方式调理。", 184),
    turn("assistant", "这个是我们顾客护理后的 Before & After 😊", 180),
    turn("assistant", "再给你看一个顾客护理后的 Before & After 😊", 175),
    turn("user", originalFee, 120),
  ];
  const clarified = [
    ...initial, turn("assistant", clarification, 75),
    turn("user", selectedService, 30),
  ];
  return { initial, clarified };
}

function pricingAssessment(customerText, conversationHistory, now) {
  const exception = resolveShadowPriceException({
    customerText, conversationHistory, ...config, now,
  });
  const approval = resolveApprovedPricingAssessment({
    mode: "shadow", shadowException: exception,
    customerText, conversationHistory, ...config, now,
  });
  return { exception, approval };
}

test("fees are not mistaken for clinical treatment suitability, but real medical concerns remain protected", () => {
  for (const ordinary of [
    originalFee, "骨盆调理一次的費用嗎？", "可以了解费用吗？",
    "可以知道收费是多少吗？",
  ]) {
    assert.equal(hasClinicalMediaRisk(ordinary), false, ordinary);
  }
  for (const concern of [
    "可以用吗？", "我可以做骨盆调理吗？",
    "刚生完2周，可以做吗？", "我怀孕了，可以做吗？",
  ]) {
    assert.equal(hasClinicalMediaRisk(concern), true, concern);
  }
});

test("contact #613 first pelvic fee question is authorized in Shadow from recent customer-selected treatment", async () => {
  const now = Date.now(), { initial } = transcript(now);
  const { exception, approval } = pricingAssessment(originalFee, initial, now);
  assert.equal(approval.reason, "approved");
  assert.equal(exception?.treatment, "骨盆调理");
  assert.equal(approval.decision?.treatment, "骨盆调理");
  assert.deepEqual(approval.decision?.prices.map(x => x.price),
    ["RM388", "RM288"]);
  const quoted = ensureVerifiedPriceReply({
    ...config, customerText: originalFee, conversationHistory: initial,
    pricingDecision: approval.decision, treatment: "骨盆调理",
    priceOnlyResponse: true, reply: clarification, language: "zh",
  });
  assert.match(quoted.reply, /Package A.*RM388/su);
  assert.match(quoted.reply, /Package B.*RM288/su);
  assert.doesNotMatch(quoted.reply, /哪一项疗程/u);
  const media = await resolvePricePromotionForReply({
    ...config, customerText: originalFee, conversationHistory: initial,
    pricingDecision: approval.decision, aiPricingEnabled: true,
    treatment: "骨盆调理", verifiedServiceFromText: "骨盆调理",
    priceQuery: true, packageQuery: false, contactId: 613, language: "zh",
    textSendSucceeded: true, wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
  });
  assert.deepEqual(media?.packages.map(x => x.name), ["Package A", "Package B"]);
});

test("contact #613 '调整骨盆' completes the immediately preceding price clarification", () => {
  const now = Date.now(), { clarified } = transcript(now);
  const { exception, approval } = pricingAssessment(selectedService, clarified, now);
  assert.equal(approval.reason, "approved");
  assert.equal(exception?.source, "customer_price_clarification");
  assert.equal(approval.decision?.treatment, "骨盆调理");
  assert.deepEqual(approval.decision?.prices.map(x => x.price),
    ["RM388", "RM288"]);
  const quoted = ensureVerifiedPriceReply({
    ...config, customerText: selectedService, conversationHistory: clarified,
    pricingDecision: approval.decision, treatment: "骨盆调理",
    priceOnlyResponse: true, reply: "目前单次价格需要向团队确认", language: "zh",
  });
  assert.match(quoted.reply, /Package A.*RM388/su);
  assert.match(quoted.reply, /Package B.*RM288/su);
  assert.doesNotMatch(quoted.reply, /需要向团队确认/u);
});

test("staff intervention or genuine clinical risk still blocks Shadow pricing", () => {
  const now = Date.now(), { initial, clarified } = transcript(now);
  const staffed = clarified.map(x => ({ ...x }));
  staffed[staffed.length - 2] = {
    ...staffed[staffed.length - 2],
    content: "[Verified STAFF message] " + clarification,
    pricingStaffAuthored: true,
  };
  assert.equal(pricingAssessment(selectedService, staffed, now).approval.decision, null);
  const concerning = [
    ...initial.slice(0, -1),
    { role: "user", content: "我怀孕了，可以做骨盆调理吗？费用多少？",
      pricingCreatedAtMs: now - 120000 },
  ];
  assert.equal(pricingAssessment(
    concerning.at(-1).content, concerning, now).approval.decision, null);
});
