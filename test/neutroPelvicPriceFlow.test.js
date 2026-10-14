"use strict";

// Regression: Neutro Sense Messenger, 14 October 2026.
// "Pelvic 价钱?" must resolve the configured 骨盆调理 alias immediately,
// quote verified A/B prices, and release the matching optional graphics.
const test = require("node:test");
const assert = require("node:assert/strict");
const clinicConfig = require("../src/config/clinicConfig");
const { hasExplicitPriceRequest } = require("../src/utils/customerEnquiryEvidence");
const { safeServiceFromCustomer } = require("../src/utils/initialOfferReplyGuard");
const { resolveVerifiedPriceFollowUpService } = require("../src/utils/priceFollowUpContext");
const { resolveClarifiedPriceService } = require("../src/utils/priceClarificationContext");
const { ensureVerifiedPriceReply } = require("../src/utils/verifiedPriceReply");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");

const services = [
  { name: "骨盆调理", priceRange: "" },
  { name: "3D 小颜术", priceRange: "" },
];
const serviceAliases = [
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "Pelvic", officialService: "骨盆调理" },
  { alias: "Pelvis", officialService: "骨盆调理" },
  { alias: "Pelvic Care", officialService: "骨盆调理" },
  { alias: "Pelvic Treatment", officialService: "骨盆调理" },
  { alias: "3D", officialService: "3D 小颜术" },
];
const promotions = [{
  name: "骨盆调理套餐",
  linkedService: "骨盆调理",
  sendOnPriceQuery: true,
  packages: [
    {
      name: "Package A",
      title: "尊享护理配套",
      imageUrl: "https://example.test/promo-images/30",
      caption: "本月限时优惠\\nRM100 优惠券限时领取\\n原价优惠 RM488\\n优惠后仅需 RM3️⃣8️⃣8️⃣",
    },
    {
      name: "Package B",
      title: "女性护理配套",
      imageUrl: "https://example.test/promo-images/31",
      caption: "本月限时优惠 RM100 OFF\\n原价 RM388\\n现在只需 RM2️⃣8️⃣8️⃣",
    },
  ],
}];

const context = { services, serviceAliases, promotions, resultMedia: [] };

function verifiedService(customerText, conversationHistory = []) {
  return safeServiceFromCustomer(customerText, services, serviceAliases)?.name ||
    resolveVerifiedPriceFollowUpService({
      customerText, conversationHistory, ...context,
    })?.name || null;
}
function verifiedReply(customerText, conversationHistory = []) {
  return ensureVerifiedPriceReply({
    customerText, conversationHistory, ...context, language: "zh",
    treatment: verifiedService(customerText, conversationHistory),
    reply: "我们有当月限时优惠哦，先来评估看看 😊",
  });
}
async function withAssessmentFirst(fn) {
  const original = clinicConfig.automatedFollowUp;
  clinicConfig.automatedFollowUp = {
    ...original, assessmentFirstPricingEnabled: true,
  };
  try { return await fn(); }
  finally { clinicConfig.automatedFollowUp = original; }
}
async function graphics(customerText, conversationHistory = [], overrides = {}) {
  const verified = verifiedService(customerText, conversationHistory);
  return resolvePricePromotionForReply({
    customerText, conversationHistory, ...context,
    treatment: verified, verifiedServiceFromText: verified,
    priceQuery: false, packageQuery: false, // Gemini needn't identify the price intent
    contactId: 26, language: "zh", textSendSucceeded: true,
    wasPromoRecentlySent: async () => false,
    hasUnconfirmedMediaDelivery: async () => false,
    ...overrides,
  });
}

test("Neutro's four configured English pelvic aliases allow a direct price question and both matching graphics", async () => {
  await withAssessmentFirst(async () => {
    for (const request of [
      "Pelvic 价钱?", "Pelvis price?", "Pelvic Care 几钱？",
      "Pelvic Treatment berapa harga?",
    ]) {
      assert.equal(hasExplicitPriceRequest(request), true, request);
      assert.equal(verifiedService(request), "骨盆调理", request);
      const quote = verifiedReply(request);
      assert.equal(quote.restored, true, request);
      assert.match(quote.reply, /Package A.*RM388/su, request);
      assert.match(quote.reply, /Package B.*RM288/su, request);
      const promo = await graphics(request);
      assert.deepEqual(promo?.packages.map((p) => p.name),
        ["Package A", "Package B"], request);
    }
  });
});

test("a second standalone 价钱? retains only the recent customer-named Pelvic context", async () => {
  await withAssessmentFirst(async () => {
    const text = "价钱？";
    const history = [
      { role: "user", content: "Pelvic 价钱?" },
      { role: "assistant", content: "我们目前有优惠哦，你想改善什么问题？" },
      { role: "user", content: text },
    ];
    assert.equal(verifiedService(text, history), "骨盆调理");
    assert.match(verifiedReply(text, history).reply, /Package A.*RM388/su);
    assert.match(verifiedReply(text, history).reply, /Package B.*RM288/su);
    assert.deepEqual((await graphics(text, history))?.packages.map(p => p.name),
      ["Package A", "Package B"]);
    assert.equal(verifiedService(text, [{ role: "user", content: text }]), null);
    assert.equal(await graphics(text, history, {
      treatment: "3D 小颜术",
    }), null, "a model-selected treatment cannot override customer evidence");
  });
});

test("Pelvic after the bot's direct price clarification completes the original enquiry", async () => {
  await withAssessmentFirst(async () => {
    const history = [
      { role: "user", content: "价钱？" },
      { role: "assistant", content: "请问你想了解哪一项疗程的价格呢？" },
      { role: "user", content: "Pelvic" },
    ];
    const treatment = resolveClarifiedPriceService({
      customerText: "Pelvic", conversationHistory: history, services, serviceAliases,
    });
    assert.equal(treatment, "骨盆调理");
    assert.equal(hasExplicitPriceRequest("Pelvic"), false);
    const quote = ensureVerifiedPriceReply({
      ...context, customerText: "Pelvic", conversationHistory: history,
      clarifiedPriceService: treatment, treatment, reply: "我帮你确认价格哦 😊",
      language: "zh",
    });
    assert.match(quote.reply, /Package A.*RM388/su);
    assert.deepEqual((await graphics("Pelvic", history, {
      treatment, verifiedServiceFromText: treatment,
    }))?.packages.map((p) => p.name), ["Package A", "Package B"]);
  });
});

test("no unsolicited prices, wrong services, uncertain delivery, or duplicate media", async () => {
  await withAssessmentFirst(async () => {
    for (const request of ["Pelvic", "我想了解 Pelvic", "Pelvic 有什么配套？"]) {
      assert.equal(hasExplicitPriceRequest(request), false, request);
      assert.equal(await graphics(request), null, request);
      assert.equal(verifiedReply(request).restored, false, request);
    }
    assert.equal(await graphics("Pelvic 价钱?", [], {
      textSendSucceeded: false,
    }), null);
    assert.equal(await graphics("Pelvic 价钱?", [], {
      hasUnconfirmedMediaDelivery: async () => true,
    }), null);
    assert.equal(await graphics("Pelvic 价钱?", [], {
      wasPromoRecentlySent: async () => true,
    }), null);
    assert.equal(verifiedService("按摩价钱？"), null);
    assert.equal(await graphics("按摩价钱？"), null);
  });
});
