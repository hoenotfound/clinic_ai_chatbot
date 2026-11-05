"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { scopeNeutroKnowledge } = require("../src/utils/scopedPromptKnowledge");
const { buildScopedReplyPrompt } = require("../src/utils/scopedReplyPrompt");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");
const gemini = require("../src/services/geminiService");

const fixture = {
  businessName: "Neutro Sense TCM Centre",
  clinicName: "Neutro Sense TCM Centre",
  aiAssistantName: "Clinic Assistant",
  businessType: "tcm_clinic",
  businessDescription: "Clinic in Malaysia",
  messagingStyle: "Answer naturally in Chinese, English or Malay.",
  guardrails: [
    "Never diagnose, prescribe, guarantee results or invent a booking.",
    "For 骨盆调理, do not invent a standalone Pelvis price.",
    "For 3D 小颜术, do not invent the post-procedure waiting period.",
    "For 9D 逆龄抗衰, never guarantee its result.",
    "Never invent 3D + 9D combination prices."
  ],
  faqs: [
    { q: "Where is the clinic?", a: "Ask staff if directions are unclear." },
    { q: "骨盆调理需要多久?", a: "Assessment precedes treatment." },
    { q: "3D 小颜术如何做?", a: "Ask the practitioner." },
    { q: "9D 逆龄抗衰如何做?", a: "Ask the practitioner." },
    { q: "What about 3D and 9D?", a: "Only approved combination offers." }
  ],
  services: [
    { name: "骨盆调理", description: "Pelvic care", priceRange: "Normal price must be confirmed", duration: "40 minutes" },
    { name: "3D 小颜术", description: "Face care", priceRange: "RM888", duration: "90 minutes" },
    { name: "9D 逆龄抗衰", description: "Ageing treatment", priceRange: "RM1288", duration: "120 minutes" }
  ],
  serviceAliases: [],
  promotions: [{
    name: "Pelvic Packages", linkedService: "骨盆调理",
    sendOnPriceQuery: true, packages: [
      { name: "Package A", caption: "RM388" },
      { name: "Package B", caption: "RM288" }
    ]
  }],
  branches: [{ name: "PJ", address: "PJ", phone: "not configured" }],
  hours: { general: "Tuesday to Sunday" },
  automatedFollowUp: { assessmentFirstPricingEnabled: true }
};

const context = (selected, current, extra = {}) => ({
  relevantServiceNames: selected,
  currentCustomerText: current,
  promotionIntent: false,
  schedulingIntent: false,
  contactIntent: false,
  ...extra
});
function withConfig(fn) {
  const saved = JSON.parse(JSON.stringify(config));
  try {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, saved, fixture);
    return fn();
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, saved);
  }
}
test("current treatment retains common and relevant safety rules", () => {
  const result = scopeNeutroKnowledge({
    config: fixture,
    conversationContext: context(["骨盆调理"], "骨盆调理价钱多少")
  });
  assert.equal(result.scoped, true);
  const qs = [...result.generalFaqs, ...result.relevantFaqs].map(f => f.q).join("|");
  const rules = [...result.generalGuardrails, ...result.relevantGuardrails].join("|");
  assert.match(qs, /Where is the clinic/);
  assert.match(qs, /骨盆调理需要多久/);
  assert.match(qs, /3D and 9D/);
  assert.doesNotMatch(qs, /3D 小颜术如何做/);
  assert.doesNotMatch(qs, /9D 逆龄抗衰如何做/);
  assert.match(rules, /Never diagnose/);
  assert.match(rules, /standalone Pelvis/);
  assert.match(rules, /3D \+ 9D/);
  assert.doesNotMatch(rules, /post-procedure waiting period/);
});
test("uncertain, multi-treatment and topic-change turns use full knowledge", () => {
  const cases = [
    context([], "多少钱"),
    context(["骨盆调理", "3D 小颜术"], "Compare both"),
    context(["骨盆调理"], "9D how much"),
    context(["骨盆调理"], "全部价格", { broadPriceIntent: true }),
    context(["骨盆调理"], "List services", { serviceDiscoveryIntent: true })
  ];
  for (const cc of cases) {
    const result = scopeNeutroKnowledge({ config: fixture, conversationContext: cc });
    assert.equal(result.scoped, false);
    assert.equal(result.generalFaqs.length, fixture.faqs.length);
    assert.equal(result.generalGuardrails.length, fixture.guardrails.length);
  }
});
test("other tenants and rollback use the unmodified prompt", () => {
  const cc = context(["骨盆调理"], "骨盆调理价钱");
  const other = { ...fixture, businessName: "Other Clinic", clinicName: "Other Clinic" };
  assert.equal(scopeNeutroKnowledge({ config: other, conversationContext: cc }).scoped, false);
  const previous = process.env.NEUTRO_PROMPT_KNOWLEDGE_SCOPING;
  try {
    process.env.NEUTRO_PROMPT_KNOWLEDGE_SCOPING = "off";
    assert.equal(scopeNeutroKnowledge({ config: fixture, conversationContext: cc }).scoped, false);
  } finally {
    if (previous === undefined) delete process.env.NEUTRO_PROMPT_KNOWLEDGE_SCOPING;
    else process.env.NEUTRO_PROMPT_KNOWLEDGE_SCOPING = previous;
  }
});
test("shorter assembled prompt keeps pricing and general booking guidance", () => {
  withConfig(() => {
    const options = { surface: "conversation", channel: "whatsapp",
      conversationContext: context(["骨盆调理"], "骨盆调理价钱多少", { promotionIntent: true }) };
    const baseline = buildSystemPrompt(options);
    const reduced = buildScopedReplyPrompt(options);
    assert.ok(reduced.length < baseline.length, "known treatment should reduce prompt size");
    for (const required of ["Package A", "Package B", "RM388", "RM288",
      "Never diagnose", "standalone Pelvis price", "骨盆调理需要多久",
      "booking_ready", "review_required", "needs_human"]) {
      assert.ok(reduced.includes(required), "lost required guidance: " + required);
    }
    assert.doesNotMatch(reduced, /3D 小颜术如何做/);
    assert.doesNotMatch(reduced, /9D 逆龄抗衰如何做/);
    assert.equal(buildScopedReplyPrompt({ ...options, conversationContext: context([], "什么价格") }),
      buildSystemPrompt({ ...options, conversationContext: context([], "什么价格") }));
    const generated = gemini.buildGeminiRequest(
      [{ role: "user", content: "骨盆调理价钱多少" }],
      { surface: "conversation", channel: "whatsapp" }, "gemini-3.8-flash");
    assert.ok(generated.request.config.systemInstruction.includes("骨盆调理需要多久"));
    assert.ok(generated.request.config.systemInstruction.length < baseline.length);
  });
});
