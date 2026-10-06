const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { buildFollowUpPrompt } = require("../src/utils/systemPrompt");

test("AI follow-up prompt keeps the decision contract while using compact business context", () => {
  const prompt = buildFollowUpPrompt({
    channel: "whatsapp",
    followUpContext: {
      stepNumber: 2,
      treatmentInterest: "3D 小颜术",
      stageName: "Warm",
      instruction: "Keep it low pressure.",
      previousFollowUps: ["Earlier follow-up"],
    },
  });

  assert.match(prompt, /CURRENT FOLLOW-UP BUSINESS CONTEXT:/);
  assert.match(prompt, /FOLLOW-UP STEP:/);
  assert.match(prompt, /Step: 2/);
  assert.match(prompt, /Current relevant promotion:/);
  assert.match(prompt, /PROMOTION AUTHORITY:/);
  assert.match(prompt, /send \| skip \| human_review/);
  assert.match(prompt, /Keep it low pressure\./);
  assert.match(prompt, /Earlier follow-up/);
  assert.match(prompt, /Messages labeled STAFF were manually sent/i);
  assert.match(
    prompt,
    /unconfigured STAFF promotion alone is not a reason for human review/i
  );
  assert.match(
    prompt,
    /customer asks to confirm that offer's current validity or missing terms.*human_review/is
  );
  assert.doesNotMatch(prompt, /Current FAQs:/);
  assert.doesNotMatch(prompt, /CURRENT SOP \/ SALES GUIDANCE:/);
});

test("AI follow-up prompt includes only the relevant service and matching promotion details", () => {
  const original = {
    services: config.services,
    serviceAliases: config.serviceAliases,
    promotions: config.promotions,
    faqs: config.faqs,
    sop: config.sop,
    closingPlaybook: config.closingPlaybook,
  };

  try {
    config.services = [
      {
        name: "Pelvic Care",
        description: "PELVIC_ONLY_DETAILS",
        priceRange: "RM388",
        duration: "60 minutes",
      },
      {
        name: "Face Lift",
        description: "UNRELATED_FACE_DETAILS",
        priceRange: "RM999",
        duration: "90 minutes",
      },
    ];
    config.serviceAliases = [
      { alias: "骨盆调理", officialService: "Pelvic Care" },
      { alias: "小颜", officialService: "Face Lift" },
    ];
    config.promotions = [
      {
        name: "Pelvic Promo",
        linkedService: "Pelvic Care",
        caption: "PELVIC_PROMO_DETAILS",
        packages: [{ name: "Package A", caption: "PELVIC_PACKAGE_DETAILS" }],
      },
      {
        name: "Face Promo",
        linkedService: "Face Lift",
        caption: "UNRELATED_FACE_PROMO",
      },
    ];
    config.faqs = [{ q: "FAQ_SENTINEL", a: "FAQ_BULK_SHOULD_NOT_APPEAR" }];
    config.sop = [
      "Pelvic Care:",
      "RELEVANT_PELVIC_SOP_GUIDANCE",
      "",
      "Face Lift:",
      "UNRELATED_FACE_SOP_GUIDANCE",
    ].join("\n");
    config.closingPlaybook = [
      "Pelvic Care:",
      "RELEVANT_PELVIC_CLOSING_GUIDANCE",
      "",
      "Face Lift:",
      "UNRELATED_FACE_CLOSING_GUIDANCE",
    ].join("\n");

    const prompt = buildFollowUpPrompt({
      channel: "whatsapp",
      followUpContext: {
        stepNumber: 1,
        treatmentInterest: "骨盆调理",
      },
    });

    assert.match(prompt, /PELVIC_ONLY_DETAILS/);
    assert.match(prompt, /骨盆调理.*Pelvic Care/);
    assert.match(prompt, /PELVIC_PROMO_DETAILS/);
    assert.match(prompt, /PELVIC_PACKAGE_DETAILS/);
    assert.doesNotMatch(prompt, /UNRELATED_FACE_DETAILS/);
    assert.doesNotMatch(prompt, /UNRELATED_FACE_PROMO/);
    assert.doesNotMatch(prompt, /FAQ_SENTINEL/);
    assert.match(prompt, /RELEVANT_PELVIC_SOP_GUIDANCE/);
    assert.match(prompt, /RELEVANT_PELVIC_CLOSING_GUIDANCE/);
    assert.doesNotMatch(prompt, /UNRELATED_FACE_SOP_GUIDANCE/);
    assert.doesNotMatch(prompt, /UNRELATED_FACE_CLOSING_GUIDANCE/);
  } finally {
    Object.assign(config, original);
  }
});

test("compact sales guidance keeps a relevant service section even inside one long SOP block", () => {
  const original = {
    services: config.services,
    serviceAliases: config.serviceAliases,
    sop: config.sop,
    closingPlaybook: config.closingPlaybook,
  };

  try {
    config.services = [{
      name: "Pelvic Care",
      description: "Pelvic service",
      priceRange: "RM388",
      duration: "60 minutes",
    }];
    config.serviceAliases = [{ alias: "骨盆调理", officialService: "Pelvic Care" }];
    config.sop = `${"UNRELATED_PREFIX ".repeat(180)} Pelvic Care RELEVANT_LATE_SOP_GUIDANCE keep the 1-to-1 assessment wording.`;
    config.closingPlaybook = "General low-pressure sales flow.";

    const prompt = buildFollowUpPrompt({
      channel: "whatsapp",
      followUpContext: {
        treatmentInterest: "骨盆调理",
      },
    });

    assert.match(prompt, /RELEVANT_LATE_SOP_GUIDANCE/);
    assert.match(prompt, /1-to-1 assessment wording/);
  } finally {
    Object.assign(config, original);
  }
});

test("follow-up prompt only includes branch and hours detail when scheduling is relevant", () => {
  const original = {
    branches: config.branches,
    hours: config.hours,
  };

  try {
    config.branches = [
      { name: "PJ", address: "SCHEDULING_ADDRESS_SENTINEL" },
    ];
    config.hours = {
      general: "SCHEDULING_HOURS_SENTINEL",
      closed: "Monday closed",
    };

    const compact = buildFollowUpPrompt({
      channel: "whatsapp",
      followUpContext: {
        treatmentInterest: "Unknown service",
        includeSchedulingContext: false,
      },
    });
    assert.doesNotMatch(compact, /SCHEDULING_ADDRESS_SENTINEL/);
    assert.doesNotMatch(compact, /SCHEDULING_HOURS_SENTINEL/);

    const scheduling = buildFollowUpPrompt({
      channel: "whatsapp",
      followUpContext: {
        treatmentInterest: "Unknown service",
        includeSchedulingContext: true,
      },
    });
    assert.match(scheduling, /SCHEDULING_ADDRESS_SENTINEL/);
    assert.match(scheduling, /SCHEDULING_HOURS_SENTINEL/);
  } finally {
    Object.assign(config, original);
  }
});
