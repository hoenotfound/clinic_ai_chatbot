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

test("home renovation prompt uses renovation language and its own conversion-ready contract", () => {
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
      assert.match(prompt, /Use outcome "booking_ready" as the backward-compatible CONVERSION-READY control/i);
      assert.match(prompt, /canonical configured renovation service/i);
      assert.match(prompt, /unknown, unsupported, or invented service/i);
      assert.match(prompt, /PROJECT LOCATION/i);
      assert.match(prompt, /PROJECT SUMMARY/i);
      assert.match(prompt, /site_visit/);
      assert.match(prompt, /quotation_discussion/);
      assert.match(prompt, /For "quotation_discussion".*timing preference is optional/is);
      assert.match(prompt, /For "site_visit".*preferred day\/date plus time\/range\/daypart are required/is);
      assert.match(prompt, /customer's property belongs in "projectLocation"/i);
      assert.match(prompt, /"appointmentPreference".*REQUIRED when "nextStep" is "site_visit"/is);
      assert.match(prompt, /legacy internal field name "treatment"/i);
      assert.doesNotMatch(prompt, /an aesthetics clinic in Malaysia/);
      assert.doesNotMatch(prompt, /guide genuinely interested patients toward booking the free consultation/i);
      assert.doesNotMatch(prompt, /Beleco Clinic/);
    }
  );
});

test("renovation prompt disables executable conversion when neutral override is off", () => {
  const profile = getIndustryProfile("home_renovation");
  profile.conversion = {
    ...profile.conversion,
    conversionReadyEnabled: false,
  };

  withProfile(profile, () => {
    const prompt = buildSystemPrompt(false);
    assert.match(prompt, /CONVERSION READY AUTOMATION FOR THIS INDUSTRY PROFILE/i);
    assert.match(prompt, /Disabled\. Never return outcome "booking_ready"/i);
  });
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

test("BB demo market references are only in explicit customer price questions", () => {
  const profile = getIndustryProfile("aesthetic_clinic");
  withProfile({
    ...profile,
    businessName: "BB World Clinique",
    clinicName: "BB World Clinique",
    services: [{
      name: "Pico Laser",
      description: "General Pico laser procedure.",
      priceRange: "BB price not confirmed; ask staff.",
      marketPriceGuide: "RM700–RM1,500 per session at other Malaysian clinics.",
      duration: "Varies",
    }],
    serviceAliases: [{ alias: "pico", officialService: "Pico Laser" }],
    promotions: [],
  }, () => {
    const current = { currentCustomerText: "Pico Laser 多少钱？", relevantServiceNames: ["Pico Laser"] };
    const pricing = buildSystemPrompt({
      channel: "facebook", conversationContext: current,
    });
    assert.match(pricing, /RM700–RM1,500/);
    assert.match(pricing, /OTHER MALAYSIAN CLINICS' DEMO MARKET REFERENCE/);
    assert.match(pricing, /NOT BB World Clinique's fee/);
    assert.match(pricing, /BB price not confirmed/);

    const general = buildSystemPrompt({
      channel: "facebook",
      conversationContext: { ...current, currentCustomerText: "我想了解 Pico Laser" },
    });
    assert.doesNotMatch(general, /RM700–RM1,500/);
    const optin = buildSystemPrompt({
      channel: "facebook", isFirstMessage: true,
      conversationContext: { ...current, futureFollowUpIntroduction: true },
    });
    assert.doesNotMatch(optin, /RM700–RM1,500/);
    assert.doesNotMatch(buildSystemPrompt({ channel: "facebook" }), /RM700–RM1,500/);
    assert.doesNotMatch(buildSystemPrompt({
      surface: "comment_automation", channel: "facebook", commentText: "Pico Laser?"
    }), /RM700–RM1,500/);
    assert.doesNotMatch(buildSystemPrompt({
      surface: "follow_up", channel: "facebook",
      followUpContext: { treatmentInterest: "Pico Laser", stepNumber: 1 },
    }), /RM700–RM1,500/);
  });
});
