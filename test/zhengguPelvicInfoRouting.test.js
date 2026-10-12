"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { inferConfiguredServiceFromText } = require("../src/utils/serviceInterest");
const { buildConversationPromptContext } = require("../src/utils/conversationPromptContext");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");
const { customerNamedServices, explicitServiceNamedByCustomer, resolveResultMediaForReply } = require("../src/utils/resultMediaTrigger");
const { hasCustomerServiceEnquiry, hasExplicitPriceRequest } = require("../src/utils/customerEnquiryEvidence");
const { planResultMediaPacing } = require("../src/utils/resultMediaPacing");
const { guardAssessmentFirstPricingReply, safeIntroReply } = require("../src/utils/initialOfferReplyGuard");
const { relatedPricingConflict } = require("../src/utils/relatedServicePolicy");
const { resolvePricePromotionForReply } = require("../src/utils/pricePromotionTrigger");
const { recentConfiguredServiceNames } = require("../src/services/followUpAiService");

const services = [
  { name: "徒手体态调理", description: "Full-body manual posture care including shoulders and back.", priceRange: "", duration: "" },
  { name: "骨盆调理", description: "Pelvic and lower body care including hip balance.", priceRange: "", duration: "30-40 minutes" },
  { name: "3D 小颜术", description: "Facial contour treatment.", priceRange: "", duration: "90 minutes" },
];
const serviceAliases = [
  { alias: "整骨", officialService: "徒手体态调理" },
  { alias: "全身整骨", officialService: "徒手体态调理" },
  { alias: "中医徒手整骨", officialService: "徒手体态调理" },
  { alias: "中医徒手整骨调理", officialService: "徒手体态调理" },
  { alias: "骨盆", officialService: "骨盆调理" },
  { alias: "骨盆整骨", officialService: "骨盆调理" },
  { alias: "小颜整骨", officialService: "3D 小颜术" },
  { alias: "整骨小颜术", officialService: "3D 小颜术" },
  { alias: "脸部整骨", officialService: "3D 小颜术" },
  { alias: "美颜整骨", officialService: "3D 小颜术" },
];
const resultMedia = [
  { service: "骨盆调理", relatedServices: ["徒手体态调理"], enabled: true, triggerMode: "service_enquiry", autoSendCount: 2, items: [
    { imageUrl: "/api/config/result-media/image/11", caption: "Pelvic example one" },
    { imageUrl: "/api/config/result-media/image/12", caption: "Pelvic example two" },
  ] },
  { service: "3D 小颜术", enabled: true, triggerMode: "service_enquiry", autoSendCount: 1, items: [
    { imageUrl: "/api/config/result-media/image/13", caption: "3D result" },
  ] },
];
const promotions = [
  { name: "Pelvic October Offer", linkedService: "骨盆调理", sendOnPriceQuery: true,
    validFrom: "2026-10-01", validUntil: "2026-10-31",
    packages: [
      { name: "Package A", imageUrl: "/api/config/result-media/image/21", caption: "RM388 pelvic care" },
      { name: "Package B", imageUrl: "/api/config/result-media/image/22", caption: "RM288 pelvic care" },
    ],
  },
];
const fixture = { services, serviceAliases, resultMedia, promotions, automatedFollowUp: { assessmentFirstPricingEnabled: true } };
const context = (message) => buildConversationPromptContext(
  [{ role: "user", content: message }],
  { services, aliases: serviceAliases, promotions: [] },
);
const mediaDecision = (customerText, overrides = {}) => resolveResultMediaForReply({
  customerText, services, serviceAliases, resultMedia,
  priceQuery: false, packageQuery: false, treatment: null,
  serviceQuery: false, serviceQuerySource: null, metaAdCreativeService: null,
  flagged: false, bookingReady: false, keywordReason: null,
  needsAttention: false, textSendSucceeded: true, contactId: 99,
  wasMediaRecentlySent: async () => false,
  hasUnconfirmedMediaDelivery: async () => false,
  getMostRecentlySentMediaUrl: async () => null,
  ...overrides,
});
function withConfig(callback) {
  const before = JSON.parse(JSON.stringify(config));
  try {
    Object.assign(config, { ...before, ...fixture, businessType: "tcm_clinic" });
    return callback();
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, before);
  }
}
const prices = (customerText, overrides = {}) => withConfig(() => resolvePricePromotionForReply({
  priceQuery: true, packageQuery: false, treatment: "骨盆调理",
  customerText, conversationHistory: [], flagged: false, bookingReady: false,
  keywordReason: null, needsAttention: false, textSendSucceeded: true,
  promotions, services, serviceAliases, resultMedia, contactId: 99,
  wasPromoRecentlySent: async () => false,
  hasUnconfirmedMediaDelivery: async () => false,
  ...overrides,
}));

test("body 整骨 remains full-body; pelvic examples are a separate related media choice", () => {
  for (const query of ["整骨", "你好，pm整骨价钱", "想了解整骨", "全身整骨", "中医徒手整骨"]) {
    assert.equal(inferConfiguredServiceFromText(query, fixture), "徒手体态调理", query);
    assert.deepEqual(context(query).relevantServiceNames, ["徒手体态调理"], query);
  }
  assert.equal(hasCustomerServiceEnquiry("整骨"), true);
  assert.equal(hasExplicitPriceRequest("我想了解整骨"), false);
  assert.equal(hasExplicitPriceRequest("你好，pm整骨价钱"), true);
  assert.deepEqual(customerNamedServices(resultMedia, "整骨", serviceAliases, services), ["徒手体态调理"]);
});

test("face/explicit pelvic enquiries remain specific, while separate mentions stay ambiguous", () => {
  for (const query of ["小颜整骨", "整骨小颜术", "脸部整骨", "美颜整骨"]) {
    assert.equal(inferConfiguredServiceFromText(query, fixture), "3D 小颜术", query);
    assert.deepEqual(context("我想了解" + query).relevantServiceNames, ["3D 小颜术"], query);
    assert.match(safeIntroReply({ customerText: "我想了解" + query, services, serviceAliases, language: "zh" }), /3D 小颜术/);
  }
  assert.equal(inferConfiguredServiceFromText("骨盆整骨", fixture), "骨盆调理");
  assert.equal(inferConfiguredServiceFromText("整骨和小颜整骨", fixture), null);
  assert.deepEqual(context("想了解整骨和小颜整骨").relevantServiceNames.sort(), ["徒手体态调理", "3D 小颜术"].sort());
});

test("body 整骨 enquiries receive pelvic results, facial enquiries receive facial results", async () => {
  for (const query of ["整骨", "你好～整骨", "你好，我想了解整骨", "我想了解全身整骨"]) {
    assert.equal(explicitServiceNamedByCustomer(resultMedia, query, serviceAliases, services), "徒手体态调理", query);
    const selected = await mediaDecision(query);
    assert.equal(selected?.service, "骨盆调理", query);
    assert.equal(selected?.serviceQuerySource, "customer_message", query);
    assert.equal(selected?.items.length, 2, query);
  }
  assert.equal((await mediaDecision("想了解小颜整骨"))?.service, "3D 小颜术");
  assert.equal(await mediaDecision("我想了解整骨和小颜整骨"), null);
});

test("related-media selection stays opt-in and fails closed if config is ambiguous", async () => {
  const withoutRelated = resultMedia.map(({ relatedServices, ...entry }) => entry);
  assert.equal(await mediaDecision("我想了解整骨", { resultMedia: withoutRelated }), null);
  assert.equal(await mediaDecision("我想了解整骨", {
    resultMedia: [...resultMedia, { ...resultMedia[0], service: "Another care" }],
  }), null);
  assert.equal((await mediaDecision("想了解骨盆调理"))?.service, "骨盆调理");
});

test("full-body 整骨 NEVER automatically sends pelvic package graphics, even when AI guesses pelvic", async () => {
  assert.equal(await prices("你好，pm整骨价钱"), null);
  assert.equal(await prices("价格？", {
    conversationHistory: [{ role: "user", content: "想了解整骨" }, { role: "user", content: "价格？" }],
  }), null);
  assert.equal(relatedPricingConflict({
    customerText: "整骨多少钱", treatment: "骨盆调理", services, serviceAliases, resultMedia,
  }), true);
  assert.equal(relatedPricingConflict({
    customerText: "骨盆调理多少钱", treatment: "骨盆调理", services, serviceAliases, resultMedia,
  }), false);
  const pelvic = await prices("骨盆调理多少钱");
  assert.equal(pelvic?.packages.length, 2);
});

test("pricing guard removes wrong pelvic prices from a body price enquiry but leaves genuine pelvic prices", () => {
  const common = { language: "zh", services, serviceAliases, resultMedia, treatment: "骨盆调理" };
  const forbidden = guardAssessmentFirstPricingReply({
    ...common, customerText: "你好，pm整骨价钱", reply: "全身整骨 RM388 / RM288",
  });
  assert.equal(forbidden.replaced, true);
  assert.doesNotMatch(forbidden.reply, /RM388|RM288/);
  assert.match(forbidden.reply, /1对1/);
  const pelvis = guardAssessmentFirstPricingReply({
    ...common, customerText: "骨盆调理多少钱", reply: "骨盆调理 Package A RM388",
  });
  assert.equal(pelvis.replaced, false);
  const noPrice = guardAssessmentFirstPricingReply({
    ...common, customerText: "我想了解整骨", reply: "我们的调理是根据体态评估。",
  });
  assert.equal(noPrice.replaced, false);
  assert.deepEqual(planResultMediaPacing({
    customerText: "你好，pm整骨价钱", promotionCount: 2, items: resultMedia[0].items,
  }).items, []);
});

test("staff review, uncertain sends, duplicate checks and clinical safety still block result photos", async () => {
  assert.equal(await mediaDecision("我想了解整骨", { needsAttention: true }), null);
  assert.equal(await mediaDecision("我想了解整骨", { wasMediaRecentlySent: async () => true }), null);
  assert.equal(await mediaDecision("我想了解整骨", { hasUnconfirmedMediaDelivery: async () => true }), null);
  assert.equal(await mediaDecision("我怀孕3个月，想了解整骨", {
    treatment: "徒手体态调理", serviceQuery: true, serviceQuerySource: "customer_message",
  }), null);
});

test("AI prompt contains correct full-body and related-pelvic facts, not client-specific code", () => withConfig(() => {
  const body = buildSystemPrompt({ conversationContext: context("想了解全身整骨") });
  assert.match(body, /Full-body manual posture care including shoulders and back/);
  assert.match(body, /RELATED TREATMENT INFORMATION/);
  assert.match(body, /Pelvic and lower body care including hip balance/);
  assert.match(body, /NOT the same treatment/);
  assert.doesNotMatch(body, /Neutro Sense offers full-body/);
  const face = buildSystemPrompt({ conversationContext: context("想了解小颜整骨") });
  assert.doesNotMatch(face, /RELATED TREATMENT INFORMATION/);
}));

test("personalized follow-up treats 小颜整骨 as 3D, not generic 骨盆", () => withConfig(() => {
  assert.deepEqual(recentConfiguredServiceNames([{ role: "user", content: "我想了解小颜整骨" }]), ["3D 小颜术"]);
  assert.deepEqual(recentConfiguredServiceNames([{ role: "user", content: "想了解全身整骨" }]), ["徒手体态调理"]);
  assert.deepEqual(recentConfiguredServiceNames([{ role: "user", content: "整骨与小颜整骨比较" }]).sort(), ["徒手体态调理", "3D 小颜术"].sort());
}));
