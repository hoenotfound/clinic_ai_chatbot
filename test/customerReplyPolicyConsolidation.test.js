"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");

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
