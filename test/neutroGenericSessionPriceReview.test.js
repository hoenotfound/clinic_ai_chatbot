"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { planNeutroReviewContinuation } = require("../src/utils/neutroReviewContinuation");
const { resolveClarifiedPriceService } = require("../src/utils/priceClarificationContext");
const { resolveShadowPriceException } = require("../src/utils/shadowPriceException");
const { resolveApprovedPricingAssessment } = require("../src/utils/approvedPricingDecision");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

// Regression from contact #9185: a generic price enquiry should not be left
// silent or silently treated as a pelvic quote just because the Meta ad says pelvis.
const services = [{ name: "骨盆调理" }, { name: "9D 逆龄抗衰" }];
const serviceAliases = [{ alias: "骨盆", officialService: "骨盆调理" }];
const promotions = [{
  name: "骨盆调理套餐", linkedService: "骨盆调理", sendOnPriceQuery: true,
  validFrom: "2000-01-01", validUntil: "2999-12-31",
  packages: [
    { name: "Package A", imageUrl: "https://example.test/pelvicA.jpg",
      caption: "Package A 现在只需 RM388（原价 RM488）",
      pricing: { currency: "MYR", offer: 388, normal: 488 } },
    { name: "Package B", imageUrl: "https://example.test/pelvicB.jpg",
      caption: "Package B 现在只需 RM288（原价 RM388）",
      pricing: { currency: "MYR", offer: 288, normal: 388 } },
  ],
}];
const now = Date.now();
const make = (role, content, msAgo) =>
  ({ role, content, pricingCreatedAtMs: now - msAgo });
const original = [
  make("user", "halo请问整骨价钱是怎么算呢", 11 * 60 * 1000),
  make("assistant", "我们中医师会先做一个免费体态评估和体验，调理收费会再确认", 10 * 60 * 1000),
  make("user", "我比较困扰腰酸 还有驼背 感觉背后很重", 7 * 60 * 1000),
  make("assistant", "中医师可以先帮你看背部和整体体态，再看怎样调理适合。你方便来PJ吗？", 6 * 60 * 1000),
  make("user", "在pj哪里呀", 60 * 1000),
  make("assistant", "我们在Dataran 3 Two Business Centre, Petaling Jaya 😊", 45 * 1000),
  make("user", "通常一个疗程多少钱呢", 1000),
];

test("contact 9185: normal session-price enquiry gets clarification, not silence or invented pelvic amounts", () => {
  const response = planNeutroReviewContinuation({
    customerText: "通常一个疗程多少钱呢",
    conversationHistory: original, services, serviceAliases, promotions, language: "zh",
  });
  assert.equal(response?.kind, "unscoped_price_clarification");
  assert.match(response.reply, /哪一项护理的收费/);
  assert.doesNotMatch(response.reply, /RM\d|Package|骨盆调理目前/u);
  // No independently customer-selected priced treatment exists here.
  const candidate = resolveShadowPriceException({
    customerText: "通常一个疗程多少钱呢",
    conversationHistory: original, services, serviceAliases, promotions, now,
  });
  assert.equal(candidate, null);
});

test("a subsequent customer choice of pelvic treatment recovers its two verified package quotes", async () => {
  const reply = planNeutroReviewContinuation({
    customerText: "通常一个疗程多少钱呢",
    conversationHistory: original, services, serviceAliases, promotions, language: "zh",
  });
  const conversation = [
    ...original,
    make("assistant", reply.reply, 500),
    make("user", "骨盆调理", 100),
  ];
  assert.equal(resolveClarifiedPriceService({
    customerText: "骨盆调理", conversationHistory: conversation, services, serviceAliases,
  }), "骨盆调理");
  const decision = resolveShadowPriceException({
    customerText: "骨盆调理", conversationHistory: conversation,
    services, serviceAliases, promotions, now,
  });
  assert.equal(decision?.treatment, "骨盆调理");
  assert.deepEqual(decision?.prices.map(x => x.price), ["RM388", "RM288"]);
  const approval = resolveApprovedPricingAssessment({
    mode: "shadow", shadowException: decision, customerText: "骨盆调理",
    conversationHistory: conversation, services, serviceAliases, resultMedia: [],
    allowOfferEnquiries: true, now,
  });
  assert.equal(approval.reason, "approved");
  const media = await resolvePricePromotionForReply({
    priceQuery: true, packageQuery: false, pricingDecision: approval.decision,
    aiPricingEnabled: true, treatment: "骨盆调理", verifiedShadowPriceService: "骨盆调理",
    verifiedServiceFromText: "骨盆调理", customerText: "骨盆调理",
    conversationHistory: conversation, promotions, services, serviceAliases,
    resultMedia: [], language: "zh", contactId: 9185, textSendSucceeded: true,
    flagged: false, bookingReady: false, needsAttention: false,
    wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
  });
  assert.deepEqual(media?.packages.map(x => x.imageUrl),
    ["https://example.test/pelvicA.jpg", "https://example.test/pelvicB.jpg"]);
});

test("ordinary fee clarifications are not generated for duration, symptoms, refusals, or unsafe questions", () => {
  for (const message of [
    "通常一个疗程做多久呢",
    "一个疗程会不会很痛？",
    "我怀孕了一个疗程多少钱",
    "不用说价钱了",
    "腰酸怎么办？",
    "没关系，价钱不重要",
    "整骨风险大吗？",
  ]) {
    const response = planNeutroReviewContinuation({
      customerText: message,
      conversationHistory: [...original.slice(0, -1), make("user", message, 1000)],
      services, serviceAliases, promotions, language: "zh",
    });
    assert.equal(response, null, message);
  }
});
