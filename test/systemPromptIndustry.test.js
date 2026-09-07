const test = require("node:test");
const assert = require("node:assert/strict");

const liveConfig = require("../src/config/clinicConfig");
const { getIndustryProfile } = require("../src/config/industryProfiles");
const { buildSystemPrompt } = require("../src/utils/systemPrompt");

function withProfile(profile, callback) {
  const previous = { ...liveConfig };
  for (const key of Object.keys(liveConfig)) delete liveConfig[key];
  Object.assign(liveConfig, profile);
  try {
    callback();
  } finally {
    for (const key of Object.keys(liveConfig)) delete liveConfig[key];
    Object.assign(liveConfig, previous);
  }
}

test("home renovation prompt uses renovation language and disables clinic booking outcome", () => {
  withProfile(
    {
      ...getIndustryProfile("home_renovation"),
      businessName: "ABC Cabinet",
      clinicName: "ABC Cabinet",
      services: [
        {
          name: "Kitchen Cabinets",
          description: "Custom kitchen cabinetry.",
          priceRange: "Quotation required",
          duration: "Depends on project scope",
        },
      ],
    },
    () => {
      const prompt = buildSystemPrompt({ channel: "whatsapp", isFirstMessage: true });

      assert.match(prompt, /ABC Cabinet/);
      assert.match(prompt, /home_renovation/);
      assert.match(prompt, /renovation service/i);
      assert.match(prompt, /site visit or quotation discussion/i);
      assert.match(prompt, /Disabled\. Never return outcome "booking_ready"/);
      assert.match(prompt, /legacy internal field name "treatment"/i);
      assert.doesNotMatch(prompt, /an aesthetics clinic in Malaysia/);
      assert.doesNotMatch(prompt, /guide genuinely interested patients toward booking the free consultation/i);
      assert.doesNotMatch(prompt, /Beleco Clinic/);
    }
  );
});

test("aesthetic profile preserves the current clinic booking behavior", () => {
  withProfile(getIndustryProfile("aesthetic_clinic"), () => {
    const prompt = buildSystemPrompt({ channel: "instagram", isFirstMessage: false });

    assert.match(prompt, /an aesthetics clinic in Malaysia/);
    assert.match(prompt, /patient-facing reply/i);
    assert.match(prompt, /Use outcome "booking_ready" ONLY/);
    assert.match(prompt, /free consultation/i);
    assert.match(prompt, /Puchong/);
    assert.match(prompt, /Instagram/);
  });
});

test("generic profile has no configured services or locations to hallucinate from", () => {
  withProfile(getIndustryProfile("generic"), () => {
    const prompt = buildSystemPrompt(false);

    assert.match(prompt, /No services are configured yet/i);
    assert.match(prompt, /No locations configured/i);
    assert.match(prompt, /Never return outcome "booking_ready"/);
    assert.doesNotMatch(prompt, /HIFU/);
  });
});
