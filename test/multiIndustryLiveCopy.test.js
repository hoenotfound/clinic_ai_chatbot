const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { getIndustryProfile } = require("../src/config/industryProfiles");
const {
  getBusinessTerminology,
  getOperationalLabels,
} = require("../src/utils/businessTerminology");
const {
  initialInboundText,
} = require("../src/services/inboundMessageClaimService");
const {
  buildConversationSummaryMessage,
} = require("../src/services/telegramAlertService");
const {
  buildImmediateAlertMessage,
} = require("../src/services/telegramImmediateAlertService");

const renovation = getIndustryProfile("home_renovation");
const clinic = getIndustryProfile("aesthetic_clinic");

function lead(overrides = {}) {
  return {
    contact_id: 12,
    whatsapp_number: "60123456789",
    name: "Alicia",
    stage_name: "Contacted",
    current_temperature: "warm",
    treatment_interest: "Kitchen Cabinets",
    branch_name: "Cheras Showroom",
    appointment_status: "none",
    ...overrides,
  };
}

function score(overrides = {}) {
  return {
    temperature: "warm",
    confidence: "medium",
    reason: "Customer is interested but has not committed yet.",
    summary: {
      treatmentInterest: "Kitchen Cabinets",
      preferredBranch: "Cheras Showroom",
      preferredAppointment: "Saturday afternoon",
      mainConcern: "Kitchen storage",
      chatSummary: "Customer asked about kitchen cabinets.",
      nextAction: "Continue the quotation discussion.",
    },
    ...overrides,
  };
}

test("backend terminology preserves clinic wording and defaults other industries to customer wording", () => {
  assert.equal(getBusinessTerminology(clinic).customerSingular, "patient");
  assert.equal(getOperationalLabels(clinic).serviceInterestLabel, "Treatment");
  assert.equal(getOperationalLabels(clinic).locationLabel, "Branch");
  assert.equal(getOperationalLabels(clinic).nextStepTimingLabel, "Appointment");

  assert.equal(getBusinessTerminology(renovation).customerSingular, "customer");
  assert.equal(getOperationalLabels(renovation).serviceInterestLabel, "Service");
  assert.equal(getOperationalLabels(renovation).locationLabel, "Business location");
  assert.equal(getOperationalLabels(renovation).nextStepTimingLabel, "Next-step timing");
});

test("stored inbound media placeholders use the active customer term", () => {
  assert.equal(
    initialInboundText({ mediaType: "audio" }, clinic),
    "🎤 [Patient sent a voice message]"
  );
  assert.equal(
    initialInboundText({ mediaType: "audio" }, renovation),
    "🎤 [Customer sent a voice message]"
  );
  assert.equal(
    initialInboundText({ mediaType: "image" }, renovation),
    "📷 [Customer sent a photo]"
  );
  assert.equal(
    initialInboundText({ unsupportedType: "sticker" }, renovation),
    "📎 [Customer sent an unsupported sticker message]"
  );
});

test("renovation Telegram conversation summaries do not expose clinic labels", () => {
  const text = buildConversationSummaryMessage({
    lead: lead(),
    score: score(),
    config: renovation,
  });

  assert.match(text, /Service: Kitchen Cabinets/);
  assert.match(text, /Business location: Cheras Showroom/);
  assert.match(text, /Next-step timing: Saturday afternoon/);
  assert.doesNotMatch(text, /Treatment:|Branch:|Appointment:/);
});

test("clinic Telegram conversation summaries preserve the existing labels", () => {
  const text = buildConversationSummaryMessage({
    lead: lead({ treatment_interest: "HIFU", branch_name: "Puchong" }),
    score: score({
      summary: {
        ...score().summary,
        treatmentInterest: "HIFU",
        preferredBranch: "Puchong",
      },
    }),
    config: clinic,
  });

  assert.match(text, /Treatment: HIFU/);
  assert.match(text, /Branch: Puchong/);
  assert.match(text, /Appointment: Saturday afternoon/);
});

test("clinic Telegram manual-review summaries use patient wording", () => {
  const text = buildConversationSummaryMessage({
    lead: lead({ treatment_interest: "HIFU", branch_name: "Puchong" }),
    score: {
      summaryUnavailable: true,
      alertType: "ai_scoring_failed",
    },
    config: clinic,
  });

  assert.match(text, /follow up with the patient\./);
  assert.doesNotMatch(text, /follow up with the customer\./);
});

test("renovation human and delivery alerts use neutral service/location labels", () => {
  for (const type of ["human_intervention", "delivery_failure"]) {
    const text = buildImmediateAlertMessage({
      type,
      context: {
        ...lead(),
        temperature: "warm",
        latest_customer_message: "Can someone help with my kitchen cabinets?",
      },
      reason: "Needs staff review.",
      config: renovation,
    });

    assert.match(text, /Service: Kitchen Cabinets/);
    assert.match(text, /Business location: Cheras Showroom/);
    assert.doesNotMatch(text, /Treatment:|Branch:/);
  }
});

test("clinic immediate alerts use patient wording", () => {
  const text = buildImmediateAlertMessage({
    type: "delivery_failure",
    context: {
      ...lead({ treatment_interest: "HIFU", branch_name: "Puchong" }),
      temperature: "warm",
      latest_customer_message: "Is HIFU suitable for me?",
    },
    reason: "Delivery failed.",
    config: clinic,
  });

  assert.match(text, /Latest Patient Message:/);
  assert.match(text, /contact the patient manually\./);
  assert.doesNotMatch(text, /Latest Customer Message:|contact the customer manually\./);
});

test("live portal and permission sources do not keep the known clinic-only copy leaks", () => {
  const root = path.join(__dirname, "..");
  const inbox = fs.readFileSync(
    path.join(root, "portal-frontend", "src", "pages", "Inbox.jsx"),
    "utf8"
  );
  const auth = fs.readFileSync(path.join(root, "src", "routes", "auth.js"), "utf8");
  const requireAuth = fs.readFileSync(
    path.join(root, "src", "middleware", "requireAuth.js"),
    "utf8"
  );
  const server = fs.readFileSync(path.join(root, "src", "server.js"), "utf8");

  assert.match(inbox, /getBusinessTerminology/);
  assert.doesNotMatch(inbox, /New patient messages will appear here automatically/);
  assert.doesNotMatch(inbox, /Select a patient to view messages and reply/);
  assert.doesNotMatch(inbox, /Message this patient/);
  assert.doesNotMatch(inbox, /the patient may not have received it/);
  assert.doesNotMatch(auth, /clinic settings/i);
  assert.doesNotMatch(requireAuth, /Clinic settings/);
  assert.doesNotMatch(server, /A patient voice message could not be transcribed/);
  assert.doesNotMatch(server, /A patient photo could not be downloaded/);
  assert.doesNotMatch(server, /\[Patient sent a photo\]/);
});
