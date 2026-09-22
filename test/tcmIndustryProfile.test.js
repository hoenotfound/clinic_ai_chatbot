const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const liveConfig = require("../src/config/clinicConfig");
const {
  SUPPORTED_BUSINESS_TYPES,
  getIndustryProfile,
  getRequestedInitialBusinessType,
  normalizeBusinessType,
} = require("../src/config/industryProfiles");
const { getBusinessProfileOptions } = require("../src/config/industrySetup");
const { getConversionProfile } = require("../src/config/conversionProfiles");
const {
  CLINIC_DEFAULT_STAGES,
  getPipelineProfile,
} = require("../src/config/pipelineProfiles");
const {
  getLeadTemperatureRuleProfile,
} = require("../src/config/leadTemperatureRuleProfiles");
const {
  classifyTemperatureMessage,
} = require("../src/services/leadTemperatureAutomation");
const { parseAiReplyResult } = require("../src/utils/aiReplyResult");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");

function withProfile(profile, callback) {
  const previous = JSON.parse(JSON.stringify(liveConfig));
  for (const key of Object.keys(liveConfig)) delete liveConfig[key];
  Object.assign(liveConfig, profile);
  try {
    return callback();
  } finally {
    for (const key of Object.keys(liveConfig)) delete liveConfig[key];
    Object.assign(liveConfig, previous);
  }
}

function configuredTcmProfile() {
  return {
    ...getIndustryProfile("tcm_clinic"),
    businessName: "Harmony TCM",
    clinicName: "Harmony TCM",
    branches: [
      {
        name: "Kajang",
        address: "Kajang, Selangor",
        phone: "",
        whatsapp: null,
      },
    ],
    services: [
      {
        name: "Acupuncture",
        description: "Practitioner-delivered acupuncture service.",
        priceRange: "RM 80",
        duration: "45 mins",
      },
    ],
  };
}

test("TCM is a first-class supported industry with practical aliases", () => {
  assert.ok(SUPPORTED_BUSINESS_TYPES.includes("tcm_clinic"));
  assert.equal(normalizeBusinessType("TCM"), "tcm_clinic");
  assert.equal(normalizeBusinessType("Traditional Chinese Medicine"), "tcm_clinic");
  assert.equal(normalizeBusinessType("Chinese Medicine"), "tcm_clinic");
  assert.equal(
    getRequestedInitialBusinessType({ INITIAL_BUSINESS_TYPE: "tcm" }),
    "tcm_clinic"
  );

  const option = getBusinessProfileOptions().find(
    (item) => item.value === "tcm_clinic"
  );
  assert.equal(option?.label, "TCM Clinic");
  assert.equal(option?.default, false);
});

test("fresh TCM profile is clinic-shaped but does not inherit aesthetic client facts", () => {
  const profile = getIndustryProfile("tcm_clinic");
  const serialized = JSON.stringify(profile).toLowerCase();

  assert.equal(profile.businessType, "tcm_clinic");
  assert.equal(profile.businessName, "Your TCM Clinic");
  assert.equal(profile.clinicName, "Your TCM Clinic");
  assert.match(profile.businessDescription, /traditional chinese medicine/i);
  assert.equal(profile.terminology.customerSingular, "patient");
  assert.equal(profile.terminology.locationSingular, "clinic branch");
  assert.equal(profile.terminology.serviceSingular, "treatment");
  assert.deepEqual(profile.services, []);
  assert.deepEqual(profile.branches, []);
  assert.deepEqual(profile.promotions, []);
  assert.deepEqual(profile.faqs, []);
  assert.doesNotMatch(serialized, /beleco/);
  assert.doesNotMatch(serialized, /hifu/);
  assert.doesNotMatch(serialized, /sculptra/);
  assert.doesNotMatch(serialized, /acupuncture/);
  assert.doesNotMatch(serialized, /cupping/);
  assert.doesNotMatch(serialized, /tuina/);
  assert.match(profile.sop, /never diagnose/i);
  assert.match(profile.sop, /prescribe herbal/i);
  assert.match(profile.sop, /prescribed medication/i);
  assert.match(profile.sop, /diastasis recti/i);
  assert.match(profile.sop, /testimonials/i);
  assert.match(profile.sop, /dampness, cold, qi, meridians/i);
  assert.ok(profile.guardrails.some((rule) => /guarantee/i.test(rule)));
  assert.ok(profile.guardrails.some((rule) => /postpartum or post-c-section/i.test(rule)));
  assert.ok(profile.guardrails.some((rule) => /centimetres lost|weight loss|body reshaping/i.test(rule)));
  assert.ok(profile.guardrails.some((rule) => /urgent medical attention/i.test(rule)));
});

test("TCM reuses appointment conversion, clinic pipeline and booking-intent rules", () => {
  const profile = getIndustryProfile("tcm_clinic");
  const conversion = getConversionProfile(profile);
  const pipeline = getPipelineProfile(profile);
  const temperatureRules = getLeadTemperatureRuleProfile(profile);

  assert.equal(conversion.enabled, true);
  assert.equal(conversion.mode, "appointment");
  assert.equal(conversion.label, "assessment or treatment appointment");

  const customized = getIndustryProfile("tcm_clinic");
  customized.conversion = {
    ...customized.conversion,
    label: "initial wellness assessment",
  };
  assert.equal(getConversionProfile(customized).label, "initial wellness assessment");
  assert.deepEqual(
    pipeline.defaultStages.map(({ name, systemKey }) => [name, systemKey]),
    CLINIC_DEFAULT_STAGES.map(({ name, systemKey }) => [name, systemKey])
  );
  assert.equal(pipeline.analytics.primarySystemKey, "appointment_set");
  assert.equal(pipeline.analytics.secondarySystemKey, "visited");
  assert.equal(temperatureRules.mode, "appointment");
  assert.equal(temperatureRules.id, "tcm_clinic");

  const hot = classifyTemperatureMessage({
    messageText: "Can I book an appointment for Saturday?",
    businessType: "tcm_clinic",
  });
  assert.equal(hot?.temperature, "hot");
  assert.equal(hot?.matchedRule, "booking_intent");
});

test("TCM assessment intent becomes Hot in English, BM and Chinese without promoting hesitant intent", () => {
  const directExamples = [
    "I want an assessment.",
    "Saya nak buat assessment.",
    "我想做评估。",
  ];

  for (const messageText of directExamples) {
    const result = classifyTemperatureMessage({
      messageText,
      businessType: "tcm_clinic",
    });
    assert.equal(result?.temperature, "hot", messageText);
    assert.equal(result?.matchedRule, "booking_intent", messageText);
  }

  assert.equal(
    classifyTemperatureMessage({
      messageText: "I don't want an assessment yet.",
      businessType: "tcm_clinic",
    }),
    null
  );

  const contextResult = classifyTemperatureMessage({
    messageText: "Yes please",
    previousBusinessMessage: "Would you like me to arrange an assessment?",
    businessType: "tcm_clinic",
  });
  assert.equal(contextResult?.temperature, "hot");
  assert.equal(contextResult?.matchedRule, "scheduling_confirmation");

  const chineseContext = classifyTemperatureMessage({
    messageText: "可以",
    previousBusinessMessage: "要不要帮你安排评估？",
    businessType: "tcm_clinic",
  });
  assert.equal(chineseContext?.temperature, "hot");
  assert.equal(chineseContext?.matchedRule, "scheduling_confirmation");
});

test("single-location TCM booking-ready automatically resolves the only configured branch", () => {
  withProfile(configuredTcmProfile(), () => {
    const valid = parseAiReplyResult(JSON.stringify({
      reply: "Noted. The clinic team will check the slot and confirm with you.",
      outcome: "booking_ready",
      branch: null,
      treatment: "Acupuncture",
      appointmentPreference: "Saturday afternoon",
    }));

    assert.equal(valid.bookingReady, true);
    assert.equal(valid.outcome, "booking_ready");
    assert.equal(valid.details.branch, "Kajang");
    assert.equal(valid.details.treatment, "Acupuncture");
    assert.equal(valid.details.appointmentPreference, "Saturday afternoon");

    assert.throws(
      () => parseAiReplyResult(JSON.stringify({
        reply: "The clinic team will check the slot.",
        outcome: "booking_ready",
        branch: "Imaginary Branch",
        treatment: "Acupuncture",
        appointmentPreference: "Saturday afternoon",
      })),
      (err) => err.code === "INVALID_AI_RESPONSE" && /branch and appointment preference/i.test(err.message)
    );
  });
});

test("multi-location TCM booking-ready still requires a real configured branch", () => {
  const profile = configuredTcmProfile();
  profile.branches = [
    ...profile.branches,
    {
      name: "Petaling Jaya",
      address: "Petaling Jaya, Selangor",
      phone: "",
      whatsapp: null,
    },
  ];

  withProfile(profile, () => {
    assert.throws(
      () => parseAiReplyResult(JSON.stringify({
        reply: "The clinic team will check the slot.",
        outcome: "booking_ready",
        branch: null,
        treatment: "Acupuncture",
        appointmentPreference: "Saturday afternoon",
      })),
      (err) => err.code === "INVALID_AI_RESPONSE" && /branch and appointment preference/i.test(err.message)
    );
  });
});

test("TCM system prompt carries TCM safety rules without aesthetic defaults", () => {
  withProfile(configuredTcmProfile(), () => {
    const prompt = buildSystemPrompt({ channel: "whatsapp", isFirstMessage: true });

    assert.match(prompt, /Harmony TCM/);
    assert.match(prompt, /Traditional Chinese Medicine/i);
    assert.match(prompt, /Acupuncture/);
    assert.match(prompt, /do not diagnose/i);
    assert.match(prompt, /herbal formula/i);
    assert.match(prompt, /prescribed medication/i);
    assert.match(prompt, /assessment or treatment appointment/i);
    assert.match(prompt, /exactly one configured clinic branch/i);
    assert.match(prompt, /do not ask the patient to choose a branch\/location solely to become booking-ready/i);
    assert.match(prompt, /diastasis recti/i);
    assert.match(prompt, /testimonials/i);
    assert.match(prompt, /centimetres lost|weight loss|body reshaping/i);
    assert.doesNotMatch(prompt, /Beleco Clinic/);
    assert.doesNotMatch(prompt, /HIFU/);
  });
});

test("TCM portal uses clinic labels and clinic conversation flow", async () => {
  const terminologyModule = await import(
    pathToFileURL(
      path.join(__dirname, "../portal-frontend/src/utils/businessTerminology.js")
    ).href
  );
  const flowModule = await import(
    pathToFileURL(
      path.join(__dirname, "../portal-frontend/src/utils/conversationFlow.js")
    ).href
  );

  const ui = terminologyModule.getBusinessTerminology({
    businessType: "tcm_clinic",
    terminology: {
      customerSingular: "patient",
      customerPlural: "patients",
    },
  });
  assert.equal(ui.businessNoun, "clinic");
  assert.equal(ui.businessNameLabel, "Clinic name");
  assert.equal(ui.locationsLabel, "Branches");
  assert.equal(ui.servicesLabel, "Treatments");
  assert.equal(ui.conversionStatusLabel, "Appointment status");
  assert.deepEqual(ui.conversionStageKeys, {
    set: "appointment_set",
    visited: "visited",
  });

  const flow = flowModule.buildConversationFlow(configuredTcmProfile());
  assert.equal(flow.businessType, "tcm_clinic");
  assert.equal(flow.conversionLabel, "assessment or treatment appointment");
  assert.equal(flow.qualification[0].label, "Treatment or concern");
  assert.equal(
    flow.outcomes.find((node) => node.id === "conversion-next-step")?.branchLabel,
    "Ready to proceed"
  );
});
