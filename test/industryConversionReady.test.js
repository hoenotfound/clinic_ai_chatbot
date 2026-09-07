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
});

test("renovation structured booking_ready accepts project details without forcing a business branch", () => {
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

test("renovation conversion-ready rejects incomplete project metadata", () => {
  withProfile(renovationProfile(), () => {
    assert.throws(
      () => parseAiReplyResult(JSON.stringify({
        reply: "Our team will contact you about a site visit.",
        outcome: "booking_ready",
        treatment: "Kitchen Cabinets",
        branch: null,
        appointmentPreference: "Saturday afternoon",
        projectLocation: null,
        projectSummary: "Kitchen cabinet enquiry.",
        nextStep: "site_visit",
      })),
      (err) => err.code === "INVALID_AI_RESPONSE"
    );
  });
});

test("renovation does not treat a customer property as a configured showroom branch", () => {
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
    assert.equal(result.details.projectLocation, "Cheras");
    assert.equal(result.details.appointmentPreference, "Saturday afternoon");
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
