const test = require("node:test");
const assert = require("node:assert/strict");

const liveConfig = require("../src/config/clinicConfig");
const { getIndustryProfile } = require("../src/config/industryProfiles");
const {
  buildImmediateAlertMessage,
  createTelegramImmediateAlertService,
} = require("../src/services/telegramImmediateAlertService");

const context = {
  contact_id: 42,
  whatsapp_number: "60123456789",
  name: "Alicia",
  whatsapp_profile_name: null,
  channel: "whatsapp",
  channel_user_id: null,
  lead_id: 9,
  temperature: "hot",
  treatment_interest: "Kitchen Cabinets",
  branch_name: null,
  stage_name: "Contacted",
  latest_customer_message_id: 777,
  latest_customer_message: "Cheras condo, kitchen cabinet. I have floor plan, can quote first?",
};

async function withProfile(profile, callback) {
  const previous = { ...liveConfig };
  for (const key of Object.keys(liveConfig)) delete liveConfig[key];
  Object.assign(liveConfig, profile);
  try {
    return await callback();
  } finally {
    for (const key of Object.keys(liveConfig)) delete liveConfig[key];
    Object.assign(liveConfig, previous);
  }
}

test("renovation conversion-ready alert shows project details and quotation action", async () => {
  await withProfile(getIndustryProfile("home_renovation"), async () => {
    const details = {
      branch: null,
      treatment: "Kitchen Cabinets",
      appointmentPreference: null,
      projectLocation: "Cheras",
      projectSummary: "Condo kitchen cabinets; customer has a floor plan.",
      nextStep: "quotation_discussion",
    };
    const text = buildImmediateAlertMessage({
      type: "booking_ready",
      context,
      reason: "Conversion ready: customer wants to proceed with a renovation quotation or site visit and provided usable project details.",
      details,
      env: { PUBLIC_BASE_URL: "https://renovation.example" },
    });

    assert.match(text, /^🔥 Renovation Lead Ready/);
    assert.match(text, /Service: Kitchen Cabinets/);
    assert.match(text, /Project location: Cheras/);
    assert.match(text, /Project: Condo kitchen cabinets; customer has a floor plan\./);
    assert.match(text, /Requested next step: Quotation discussion/);
    assert.doesNotMatch(text, /Preferred timing:/);
    assert.match(text, /continue the quotation or site-visit arrangement/i);
    assert.doesNotMatch(text, /confirm the appointment availability/i);
    assert.doesNotMatch(text, /Branch: Not captured/i);
  });
});

test("renovation site-visit alert includes the captured preferred timing", async () => {
  await withProfile(getIndustryProfile("home_renovation"), async () => {
    const text = buildImmediateAlertMessage({
      type: "booking_ready",
      context: {
        ...context,
        latest_customer_message: "Saturday afternoon can come Cheras for site visit?",
      },
      reason: "Conversion ready: customer wants to proceed with a renovation site visit.",
      details: {
        treatment: "Kitchen Cabinets",
        projectLocation: "Cheras",
        projectSummary: "Condo kitchen cabinet project; customer requested a site visit.",
        nextStep: "site_visit",
        appointmentPreference: "Saturday afternoon",
      },
      env: { PUBLIC_BASE_URL: "https://renovation.example" },
    });

    assert.match(text, /Requested next step: Site visit/);
    assert.match(text, /Preferred timing: Saturday afternoon/);
  });
});

test("renovation alert service carries structured project details through to Telegram", async () => {
  await withProfile(getIndustryProfile("home_renovation"), async () => {
    const sent = [];
    const service = createTelegramImmediateAlertService({
      env: {
        TELEGRAM_ALERTS_ENABLED: "true",
        TELEGRAM_BOT_TOKEN: "test-token",
        TELEGRAM_CHAT_ID: "test-chat",
      },
      async getContext() {
        return context;
      },
      async claimAlert() {
        return true;
      },
      async releaseAlert() {},
      async sendMessage(input) {
        sent.push(input);
        return { ok: true };
      },
    });

    const result = await service.sendBookingReadyAlert({
      contactId: 42,
      messageId: 777,
      reason: "Ready for quotation discussion.",
      details: {
        projectLocation: "Cheras",
        projectSummary: "Condo kitchen cabinets; customer has a floor plan.",
        nextStep: "quotation_discussion",
      },
    });

    assert.equal(result.status, "sent");
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /^🔥 Renovation Lead Ready/);
    assert.match(sent[0].text, /Project location: Cheras/);
  });
});
