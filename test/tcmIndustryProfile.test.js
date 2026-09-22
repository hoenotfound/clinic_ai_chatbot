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
  assert.match(profile.sop, /never diagnose/i);
  assert.match(profile.sop, /prescribe herbal/i);
  assert.match(profile.sop, /prescribed medication/i);
  assert.ok(profile.guardrails.some((rule) => /guarantee/i.test(rule)));
  assert.ok(profile.guardrails.some((rule) => /urgent medical attention/i.test(rule)));
});

test("TCM reuses appointment conversion, clinic pipeline and booking-intent rules", () => {
  const profile = getIndustryProfile("tcm_clinic");
  const conversion = getConversionProfile(profile);
  const pipeline = getPipelineProfile(profile);
  const temperatureRules = getLeadTemperatureRuleProfile(profile);

  assert.equal(conversion.enabled, true);
  assert.equal(conversion.mode, "appointment");
  assert.match(conversion.label, /consultation|treatment appointment/i);
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

test("TCM booking-ready output requires a configured clinic branch and timing", () => {
  withProfile(configuredTcmProfile(), () => {
    const valid = parseAiReplyResult(JSON.stringify({
      reply: "Noted. The clinic team will check the slot and confirm with you.",
      outcome: "booking_ready",
      branch: "Kajang",
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
        reply: "The team will confirm with you.",
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
    assert.match(prompt, /consultation or treatment appointment/i);
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
  assert.match(flow.conversionLabel, /consultation|treatment appointment/i);
  assert.equal(flow.qualification[0].label, "Treatment or concern");
  assert.equal(
    flow.outcomes.find((node) => node.id === "conversion-next-step")?.branchLabel,
    "Ready to proceed"
  );
});
