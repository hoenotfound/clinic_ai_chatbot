"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { inferConfiguredServiceFromText } = require("../src/utils/serviceInterest");
const { buildConversationPromptContext } = require("../src/utils/conversationPromptContext");
const { explicitServiceNamedByCustomer, resolveResultMediaForReply } = require("../src/utils/resultMediaTrigger");
const { hasCustomerServiceEnquiry, hasExplicitPriceRequest } = require("../src/utils/customerEnquiryEvidence");
const { planResultMediaPacing } = require("../src/utils/resultMediaPacing");
const { guardAssessmentFirstPricingReply, safeIntroReply } = require("../src/utils/initialOfferReplyGuard");

const services = [
  { name: "徒手体态调理" },
  { name: "骨盆调理" },
  { name: "3D 小颜术" },
];
const serviceAliases = [
  { alias: "徒手调理", officialService: "徒手体态调理" },
  { alias: "整骨", officialService: "骨盆调理" },
  { alias: "全身整骨", officialService: "骨盆调理" },
  { alias: "中医徒手整骨", officialService: "骨盆调理" },
  { alias: "小颜整骨", officialService: "3D 小颜术" },
  { alias: "整骨小颜术", officialService: "3D 小颜术" },
  { alias: "脸部整骨", officialService: "3D 小颜术" },
  { alias: "美颜整骨", officialService: "3D 小颜术" },
];
const config = { services, serviceAliases };
const media = [
  { service: "骨盆调理", enabled: true, triggerMode: "service_enquiry", autoSendCount: 2, items: [
    { imageUrl: "/api/config/result-media/image/11", caption: "Pelvic result 1" },
    { imageUrl: "/api/config/result-media/image/12", caption: "Pelvic result 2" },
  ] },
  { service: "3D 小颜术", enabled: true, triggerMode: "service_enquiry", autoSendCount: 1, items: [
    { imageUrl: "/api/config/result-media/image/13", caption: "3D result" },
  ] },
];
const promptContext = (text) => buildConversationPromptContext(
  [{ role: "user", content: text }], { services, aliases: serviceAliases, promotions: [] }
);
const resultDecision = (customerText, overrides = {}) => resolveResultMediaForReply({
  customerText, resultMedia: media, services, serviceAliases,
  priceQuery: false, packageQuery: false, treatment: null,
  serviceQuery: false, serviceQuerySource: null, metaAdCreativeService: null,
  flagged: false, bookingReady: false, keywordReason: null,
  needsAttention: false, textSendSucceeded: true,
  contactId: 99, wasMediaRecentlySent: async () => false,
  hasUnconfirmedMediaDelivery: async () => false,
  getMostRecentlySentMediaUrl: async () => null,
  ...overrides,
});

test("整骨 and full-body 整骨 identify the configured pelvic information, not an invented service", () => {
  for (const query of ["整骨", "你好，pm整骨价钱", "想了解整骨", "全身整骨", "中医徒手整骨"]) {
    assert.equal(inferConfiguredServiceFromText(query, config), "骨盆调理", query);
    assert.deepEqual(promptContext(query).relevantServiceNames, ["骨盆调理"], query);
  }
  assert.equal(hasCustomerServiceEnquiry("整骨"), true);
  assert.equal(hasCustomerServiceEnquiry("想了解整骨"), true);
  assert.equal(hasExplicitPriceRequest("你好，pm整骨价钱"), true);
  assert.equal(hasExplicitPriceRequest("我想了解整骨"), false);
});

test("face 整骨 is still 3D, and a genuinely separate face plus body enquiry is ambiguous", () => {
  for (const query of ["小颜整骨", "整骨小颜术", "脸部整骨", "美颜整骨"]) {
    assert.equal(inferConfiguredServiceFromText(query, config), "3D 小颜术", query);
    assert.deepEqual(promptContext("想了解" + query).relevantServiceNames, ["3D 小颜术"], query);
    assert.match(safeIntroReply({ customerText: "想了解" + query, services, serviceAliases, language: "zh" }), /3D 小颜术/);
  }
  assert.equal(inferConfiguredServiceFromText("想了解整骨和小颜整骨", config), null);
  assert.deepEqual(promptContext("想了解整骨和小颜整骨").relevantServiceNames.sort(), ["3D 小颜术", "骨盆调理"].sort());
});

test("an explicit 整骨 enquiry sends the configured pelvic examples with no price request", async () => {
  for (const query of ["整骨", "你好～整骨", "你好，我想了解整骨", "我想了解全身整骨"]) {
    assert.equal(explicitServiceNamedByCustomer(media, query, serviceAliases, services), "骨盆调理", query);
    const result = await resultDecision(query);
    assert.equal(result?.service, "骨盆调理", query);
    assert.equal(result?.items.length, 2, query);
    assert.equal(result?.serviceQuerySource, "customer_message");
  }
  const face = await resultDecision("我想了解小颜整骨");
  assert.equal(face?.service, "3D 小颜术");
  assert.equal(face?.items.length, 1);
  assert.equal(await resultDecision("我想了解整骨和小颜整骨"), null);
});

test("price-only 整骨 question prioritizes price graphics; no unsolicited prices", async () => {
  const price = "你好，pm整骨价钱";
  assert.deepEqual(planResultMediaPacing({
    customerText: price, promotionCount: 2, items: media[0].items,
  }).items, []);
  assert.deepEqual(planResultMediaPacing({
    customerText: "我想了解整骨", promotionCount: 0, items: media[0].items,
  }).items.length, 2);
  const guarded = guardAssessmentFirstPricingReply({
    customerText: "我想了解整骨",
    reply: "骨盆配套 RM388 / RM288",
    language: "zh", treatment: "骨盆调理", services, serviceAliases,
  });
  assert.equal(guarded.replaced, true);
  assert.doesNotMatch(guarded.reply, /RM388|RM288/);
  assert.match(guarded.reply, /1对1/);
  const asked = guardAssessmentFirstPricingReply({
    customerText: price, reply: "骨盆配套 RM388 / RM288",
    language: "zh", treatment: "骨盆调理", services, serviceAliases,
  });
  assert.equal(asked.replaced, false);
});

test("duplicate protection, staff review and clinical contraindications still suppress proof", async () => {
  assert.equal(await resultDecision("我想了解整骨", { needsAttention: true }), null);
  assert.equal(await resultDecision("我想了解整骨", { wasMediaRecentlySent: async () => true }), null);
  assert.equal(await resultDecision("我想了解整骨", { hasUnconfirmedMediaDelivery: async () => true }), null);
  assert.equal(await resultDecision("我怀孕3个月，想了解整骨", {
    treatment: "骨盆调理", serviceQuery: true, serviceQuerySource: "customer_message",
  }), null);
});


test("the scoped AI prompt describes 整骨 as whole-body, not pelvis-only", () => {
  const config = require("../src/config/clinicConfig");
  const { buildSystemPrompt } = require("../src/utils/systemPrompt");
  const saved = JSON.parse(JSON.stringify(config));
  try {
    Object.assign(config, {
      ...saved, businessType: "tcm_clinic", businessName: "Neutro Sense TCM",
      services, serviceAliases, promotions: [],
    });
    const body = buildSystemPrompt({ conversationContext: promptContext("我想了解全身整骨") });
    assert.match(body, /WHOLE-BODY 整骨 ENQUIRY/);
    assert.match(body, /not pelvis-only treatment/);
    assert.match(body, /do not imply every customer needs pelvic correction/i);
    const face = buildSystemPrompt({ conversationContext: promptContext("我想了解小颜整骨") });
    assert.doesNotMatch(face, /WHOLE-BODY 整骨 ENQUIRY/);
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, saved);
  }
});
