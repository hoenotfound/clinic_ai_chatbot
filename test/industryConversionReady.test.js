const test = require("node:test");
const assert = require("node:assert/strict");

const liveConfig = require("../src/config/clinicConfig");
const { getConversionProfile } = require("../src/config/conversionProfiles");
const { getIndustryProfile } = require("../src/config/industryProfiles");
const { parseAiReplyResult } = require("../src/utils/aiReplyResult");

function withProfile(profile, callback) {
  const previous = { ...liveConfig };
  for (const key of Object.keys(liveConfig)) delete liveConfig[key];
  Object.assign(liveConfig, profile);
  try {
    return callback();
  } finally {
    for (const key of Object.keys(liveConfig)) delete liveConfig[key];
    Object.assign(liveConfig, previous);
  }
}

function renovationProfile() {
  return {
    ...getIndustryProfile("home_renovation"),
    services: [
      {
        name: "Kitchen Cabinets",
        description: "Custom kitchen cabinetry.",
        priceRange: "Quotation required",
        duration: "Depends on scope",
      },
    ],
    serviceAliases: [
      {
        alias: "kitchen cabinet",
        officialService: "Kitchen Cabinets",
      },
    ],
    branches: [
      {
        name: "Puchong Showroom",
        address: "Puchong, Selangor",
        phone: "",
      },
    ],
  };
}

test("renovation gets an executable project conversion contract above the legacy clinic gate", () => {
  const profile = renovationProfile();
  assert.equal(profile.conversion.bookingReadyEnabled, false);

  const conversion = getConversionProfile(profile);
  assert.equal(conversion.enabled, true);
  assert.equal(conversion.mode, "project");
  assert.match(conversion.label, /site visit|quotation/i);
  assert.deepEqual(conversion.requirements.quotation_discussion, [
    "treatment",
    "projectLocation",
    "projectSummary",
  ]);
  assert.deepEqual(conversion.requirements.site_visit, [
    "treatment",
    "projectLocation",
    "projectSummary",
    "appointmentPreference",
  ]);
});

test("neutral conversionReadyEnabled override can disable renovation conversion execution", () => {
  const profile = renovationProfile();
  profile.conversion = {
    ...profile.conversion,
    conversionReadyEnabled: false,
  };

  assert.equal(getConversionProfile(profile).enabled, false);

  withProfile(profile, () => {
    const result = parseAiReplyResult(JSON.stringify({
      reply: "Our team will review the project details with you.",
      outcome: "booking_ready",
      treatment: "Kitchen Cabinets",
      projectLocation: "Cheras",
      projectSummary: "Condo kitchen cabinet project.",
      nextStep: "quotation_discussion",
    }));

    assert.equal(result.bookingReady, false);
    assert.equal(result.outcome, "normal");
  });
});

test("neutral conversionReadyEnabled override takes precedence over the legacy clinic gate", () => {
  const profile = getIndustryProfile("aesthetic_clinic");
  profile.conversion = {
    ...profile.conversion,
    bookingReadyEnabled: false,
    conversionReadyEnabled: true,
  };

  assert.equal(getConversionProfile(profile).enabled, true);
});

test("renovation quotation discussion accepts canonical service and project details without timing or business branch", () => {
  withProfile(renovationProfile(), () => {
    const result = parseAiReplyResult(JSON.stringify({
      reply: "Can 👍 our team will review your Cheras kitchen project and confirm the quotation discussion next.",
      outcome: "booking_ready",
      treatment: "Kitchen Cabinets",
      branch: null,
      appointmentPreference: null,
      projectLocation: "Cheras, Kuala Lumpur",
      projectSummary: "Condo kitchen cabinets, customer has floor plan and is targeting renovation next month.",
      nextStep: "quotation_discussion",
    }));

    assert.equal(result.bookingReady, true);
    assert.equal(result.outcome, "booking_ready");
    assert.deepEqual(result.details, {
      branch: null,
      treatment: "Kitchen Cabinets",
      appointmentPreference: null,
      projectLocation: "Cheras, Kuala Lumpur",
      projectSummary: "Condo kitchen cabinets, customer has floor plan and is targeting renovation next month.",
      nextStep: "quotation_discussion",
    });
  });
});

test("renovation conversion-ready resolves a configured service alias to its canonical configured service", () => {
  withProfile(renovationProfile(), () => {
    const result = parseAiReplyResult(JSON.stringify({
      reply: "Can 👍 our team will review the quotation discussion next.",
      outcome: "booking_ready",
      treatment: "kitchen cabinet",
      branch: null,
      appointmentPreference: null,
      projectLocation: "Cheras",
      projectSummary: "Condo kitchen cabinet project with floor plan available.",
      nextStep: "quotation_discussion",
    }));

    assert.equal(result.bookingReady, true);
    assert.equal(result.details.treatment, "Kitchen Cabinets");
  });
});

test("configured service alias cannot bypass the requirement for an existing canonical service", () => {
  const profile = renovationProfile();
  profile.serviceAliases = [
    ...profile.serviceAliases,
    {
      alias: "bathroom waterproofing",
      officialService: "Bathroom Waterproofing",
    },
  ];

  withProfile(profile, () => {
    assert.throws(
      () => parseAiReplyResult(JSON.stringify({
        reply: "Our team will review the bathroom project for a quotation discussion.",
        outcome: "booking_ready",
        treatment: "bathroom waterproofing",
        projectLocation: "Cheras",
        projectSummary: "Bathroom waterproofing enquiry for a condo.",
        nextStep: "quotation_discussion",
      })),
      (err) => err.code === "INVALID_AI_RESPONSE" && /treatment/.test(err.message)
    );
  });
});

test("renovation conversion-ready rejects a missing configured service", () => {
  withProfile(renovationProfile(), () => {
    assert.throws(
      () => parseAiReplyResult(JSON.stringify({
        reply: "Our team will review the project for a quotation discussion.",
        outcome: "booking_ready",
        treatment: null,
        projectLocation: "Cheras",
        projectSummary: "Customer wants renovation work for a condo.",
        nextStep: "quotation_discussion",
      })),
      (err) => err.code === "INVALID_AI_RESPONSE" && /treatment/.test(err.message)
    );
  });
});

test("renovation conversion-ready rejects an unconfigured or hallucinated service", () => {
  withProfile(renovationProfile(), () => {
    assert.throws(
      () => parseAiReplyResult(JSON.stringify({
        reply: "Our team will review the bathroom project for a quotation discussion.",
        outcome: "booking_ready",
        treatment: "Bathroom Waterproofing",
        projectLocation: "Cheras",
        projectSummary: "Bathroom waterproofing enquiry for a condo.",
        nextStep: "quotation_discussion",
      })),
      (err) => err.code === "INVALID_AI_RESPONSE" && /treatment/.test(err.message)
    );
  });
});

test("renovation conversion-ready rejects incomplete project metadata", () => {
  withProfile(renovationProfile(), () => {
    assert.throws(
      () => parseAiReplyResult(JSON.stringify({
        reply: "Our team will contact you about a quotation discussion.",
        outcome: "booking_ready",
        treatment: "Kitchen Cabinets",
        branch: null,
        appointmentPreference: null,
        projectLocation: null,
        projectSummary: "Kitchen cabinet enquiry.",
        nextStep: "quotation_discussion",
      })),
      (err) => err.code === "INVALID_AI_RESPONSE" && /projectLocation/.test(err.message)
    );
  });
});

test("renovation site visit is not conversion-ready until preferred timing is captured", () => {
  withProfile(renovationProfile(), () => {
    assert.throws(
      () => parseAiReplyResult(JSON.stringify({
        reply: "Sure, what day and time would be convenient for the site visit?",
        outcome: "booking_ready",
        treatment: "Kitchen Cabinets",
        branch: null,
        appointmentPreference: null,
        projectLocation: "Cheras",
        projectSummary: "Terrace house kitchen cabinet replacement.",
        nextStep: "site_visit",
      })),
      (err) => err.code === "INVALID_AI_RESPONSE" && /appointmentPreference/.test(err.message)
    );
  });
});

test("renovation site visit becomes conversion-ready with configured service, project details, and timing", () => {
  withProfile(renovationProfile(), () => {
    const result = parseAiReplyResult(JSON.stringify({
      reply: "Our team will review the project and confirm the site-visit next step.",
      outcome: "booking_ready",
      treatment: "Kitchen Cabinets",
      branch: "Cheras",
      appointmentPreference: "Saturday afternoon",
      projectLocation: "Cheras",
      projectSummary: "Terrace house kitchen cabinet replacement, Saturday afternoon preferred for a visit.",
      nextStep: "site_visit",
    }));

    assert.equal(result.bookingReady, true);
    assert.equal(result.details.branch, null);
    assert.equal(result.details.treatment, "Kitchen Cabinets");
    assert.equal(result.details.projectLocation, "Cheras");
    assert.equal(result.details.appointmentPreference, "Saturday afternoon");
    assert.equal(result.details.nextStep, "site_visit");
  });
});

test("renovation suppresses legacy BOOKING_READY markers because they cannot carry project metadata", () => {
  withProfile(renovationProfile(), () => {
    const result = parseAiReplyResult(
      "[[BOOKING_READY]] our team will follow up on your renovation enquiry"
    );

    assert.equal(result.bookingReady, false);
    assert.equal(result.outcome, "normal");
    assert.equal(result.structured, false);
    assert.equal(result.text, "our team will follow up on your renovation enquiry");
  });
});
