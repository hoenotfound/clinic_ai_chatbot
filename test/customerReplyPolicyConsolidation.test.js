"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");
const { getIndustryProfile } = require("../src/config/industryProfiles");
const gemini = require("../src/services/geminiService");
const path = require("node:path");
const Module = require("node:module");
const { execFileSync } = require("node:child_process");

function withTcmConfig(overrides, callback) {
  const saved = JSON.parse(JSON.stringify(config));
  try {
    Object.assign(config, {
      businessType: "tcm_clinic",
      businessName: "Test TCM",
      clinicName: "Test TCM",
      automatedFollowUp: {
        ...config.automatedFollowUp,
        assessmentFirstPricingEnabled: true,
        complimentaryAssessmentExperienceEnabled: true,
      },
      ...overrides,
    });
    return callback();
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, saved);
  }
}

test("consolidated reply policy retains pricing, booking, clinical and media safeguards", () => {
  withTcmConfig({}, () => {
    const prompt = buildSystemPrompt({
      channel: "whatsapp",
      conversationContext: {
        relevantServiceNames: [],
        currentCustomerText: "我想了解骨盆调理",
        schedulingIntent: false,
        contactIntent: false,
      },
    });

    assert.match(prompt, /ASSESSMENT-FIRST PRICING POLICY/);
    assert.match(prompt, /explicit CURRENT monetary question/);
    assert.match(prompt, /consent for FUTURE promotions are not monetary requests/);
    assert.match(prompt, /RM100 骨盆调理 voucher/);
    assert.match(prompt, /does not automatically stack with discounted packages/);
    assert.match(prompt, /Do not send package graphics unless current-price request was explicit/);
    assert.match(prompt, /complete introductory 1对1的体态评估 \+ 体验 is FREE/);
    assert.match(prompt, /NOT a free full pelvic, 3D or 9D treatment/);
    assert.match(prompt, /CONVERSATION-TO-APPOINTMENT CONTINUITY/);
    assert.match(prompt, /a preference is not a confirmed booking/);
    assert.match(prompt, /requests for no reminders; do not push again/);
    assert.match(prompt, /TCM ENQUIRIES ABOUT BODY AREAS VS MEDICAL JUDGMENT/);
    assert.match(prompt, /L4\/L5/);
    assert.match(prompt, /earlier medical concerns available for practitioner review/);
    assert.match(prompt, /use "review_required"/);
    assert.match(prompt, /use "needs_human"/);
    assert.match(prompt, /Preserve earlier medical\/spinal concerns for practitioner review/);
    assert.match(prompt, /do not turn an unresolved clinical question into a normal sales reply/i);
    assert.match(prompt, /limited safe acknowledgement while clinical review remains pending/);
    assert.match(prompt, /must not clear that review or imply medical clearance/);
    assert.match(prompt, /Later unrelated administrative questions may still receive a normal verified answer/);
    assert.match(prompt, /independently eligible Before & After examples/);
    assert.match(prompt, /An explicit price question is NOT required/);
    assert.match(prompt, /clinical safety, duplicate, staff-handoff and channel-delivery checks/);
    assert.match(prompt, /Never borrow its price, discount, bundle, free add-on, or deadline for another service/);
    assert.match(prompt, /"outcome": "normal \| review_required \| needs_human \| booking_ready"/);
    assert.equal((prompt.match(/ASSESSMENT-FIRST PRICING POLICY/g) || []).length, 1);
    assert.equal((prompt.match(/TCM ENQUIRIES ABOUT BODY AREAS VS MEDICAL JUDGMENT/g) || []).length, 1);

    const pricing = prompt.split("ASSESSMENT-FIRST PRICING POLICY")[1]
      .split("CONVERSATION-TO-APPOINTMENT CONTINUITY")[0];
    assert.ok(pricing.length < 1700, "assessment-first rules should stay concise");
  });
});

test("consolidation does not promise free assessment when the configured fact is disabled", () => {
  withTcmConfig({
    automatedFollowUp: {
      ...config.automatedFollowUp,
      assessmentFirstPricingEnabled: true,
      complimentaryAssessmentExperienceEnabled: false,
    },
  }, () => {
    const prompt = buildSystemPrompt({channel: "whatsapp"});
    assert.doesNotMatch(prompt, /complete introductory 1对1的体态评估 \+ 体验 is FREE/);
    assert.match(prompt, /Do not claim a free assessment or experience unless both are confirmed/);
  });
});

function withCompleteProfile(profile, callback) {
  const saved = JSON.parse(JSON.stringify(config));
  try {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, profile);
    return callback();
  } finally {
    for (const key of Object.keys(config)) delete config[key];
    Object.assign(config, saved);
  }
}

test("non-TCM industries retain their own rules, output schema and language guidance", () => {
  for (const industry of ["aesthetic_clinic", "home_renovation", "generic"]) {
    withCompleteProfile(getIndustryProfile(industry), () => {
      const prompt = buildSystemPrompt({
        channel: "facebook",
        conversationContext: {currentCustomerText: "Can you explain the service?"},
      });
      assert.match(prompt, /currently replying on Facebook Messenger/);
      assert.match(prompt, /STRUCTURED OUTPUT/);
      assert.match(prompt, /"priceQuery": false/);
      assert.match(prompt, /LANGUAGE:/);
      assert.doesNotMatch(prompt, /TCM ENQUIRIES ABOUT BODY AREAS VS MEDICAL JUDGMENT/);
      assert.doesNotMatch(prompt, /Preserve earlier medical\/spinal concerns/);
      assert.doesNotMatch(prompt, /RM100 骨盆调理 voucher/);
    });
  }
});

test("TCM safety text is retained even with assessment-first pricing disabled", () => {
  withTcmConfig({
    automatedFollowUp: {...config.automatedFollowUp, assessmentFirstPricingEnabled: false},
  }, () => {
    const prompt = buildSystemPrompt({channel: "instagram"});
    assert.doesNotMatch(prompt, /ASSESSMENT-FIRST PRICING POLICY/);
    assert.match(prompt, /TCM ENQUIRIES ABOUT BODY AREAS VS MEDICAL JUDGMENT/);
    assert.match(prompt, /clinical review remains pending/);
    assert.match(prompt, /use "needs_human" for urgent risk/);
    assert.match(prompt, /An explicit price question is NOT required/);
  });
});


function readPreConsolidationPromptBuilder() {
  // Comparison-only. Full-history GitHub CI checkout has this original PR base,
  // but local shallow clones may not. Never call Gemini or modify configuration.
  const root = path.resolve(__dirname, "..");
  const filename = path.join(root, "src/utils/systemPrompt.js");
  try {
    const source = execFileSync(
      "git",
      ["show", "1d9c506ab2e0820b26c5350aaa699d122f330b7a:src/utils/systemPrompt.js"],
      {cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000}
    );
    const previous = new Module(filename, module);
    previous.filename = filename;
    previous.paths = Module._nodeModulePaths(path.dirname(filename));
    previous._compile(source, filename);
    return previous.exports.buildSystemPrompt;
  } catch {
    return null;
  }
}

test("rendered Gemini request prompt size is recorded for reproducible scenarios without API calls", (t) => {
  withTcmConfig({
    services: [
      {name: "骨盆调理", description: "Manual pelvic and posture assessment and care.", duration: "40 minutes", priceRange: "Ask staff for single price"},
      {name: "3D 小颜术", description: "Manual non-injection facial care.", duration: "90 minutes", priceRange: "RM888"},
    ],
    serviceAliases: [{alias: "pelvic adjustment", officialService: "骨盆调理"}],
    promotions: [],
    faqs: [{q: "Is it guaranteed?", a: "Individual results vary. Practitioner review may be needed."}],
    guardrails: ["Do not promise a guaranteed result or invent a clinical diagnosis."],
    sop: "Clinical suitability requires a qualified practitioner's review.",
    closingPlaybook: "Answer the current enquiry before proposing an assessment.",
  }, () => {
    const scenarios = [
      {name: "pelvic_interest_zh", message: "我想了解骨盆调理", services: ["骨盆调理"]},
      {name: "pelvic_price_en", message: "How much is pelvic adjustment?", services: ["骨盆调理"]},
      {name: "clinical_question_ms", message: "Rawatan ini sesuai untuk saya selepas pembedahan?", services: ["骨盆调理"]},
    ];
    const priorBuilder = readPreConsolidationPromptBuilder();
    const counts = scenarios.map(({name, message, services}) => {
      const options = {
        surface: "conversation",
        channel: "whatsapp",
        conversationContext: {
          currentCustomerText: message,
          relevantServiceNames: services,
          serviceSource: "current_customer",
          promotionIntent: /price|how much/i.test(message),
        },
      };
      const result = gemini.buildGeminiRequest(
        [{role: "user", content: message}],
        options,
        "gemini-3.8-flash"
      );
      const prompt = result.request.config.systemInstruction;
      assert.ok(typeof prompt === "string" && prompt.length > 2000);
      const baselineCharacters = priorBuilder ? priorBuilder(options).length : null;
      return {
        name, systemInstructionCharacters: prompt.length, baselineCharacters,
        savedCharacters: baselineCharacters == null ? null : baselineCharacters - prompt.length,
        savedPercent: baselineCharacters == null ? null :
          Number(((baselineCharacters - prompt.length) * 100 / baselineCharacters).toFixed(2)),
      };
    });
    t.diagnostic("Non-billable rendered prompt comparison (same fixture, characters NOT provider tokens): " + JSON.stringify(counts));
  });
});
