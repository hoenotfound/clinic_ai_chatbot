const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildConversationSummaryMessage,
  formatContactIdentifier,
} = require("../src/services/telegramAlertService");
const {
  buildImmediateAlertMessage,
} = require("../src/services/telegramImmediateAlertService");

const score = {
  temperature: "warm",
  confidence: "medium",
  reason: "Customer is asking about treatment details.",
  summary: {
    treatmentInterest: "HIFU",
    preferredBranch: "Puchong",
    preferredAppointment: null,
    mainConcern: "Treatment details",
    chatSummary: "Customer asked about HIFU.",
    nextAction: "Answer the customer's questions.",
  },
};

test("WhatsApp Telegram identifiers keep the existing phone-number format", () => {
  assert.equal(
    formatContactIdentifier({
      channel: "whatsapp",
      whatsapp_number: "60123456789",
      channel_user_id: "60123456789",
    }),
    "+60123456789"
  );
});

test("Facebook and Instagram Telegram identifiers use channel-specific IDs", () => {
  assert.equal(
    formatContactIdentifier({
      channel: "facebook",
      whatsapp_number: "facebook:psid-123",
      channel_user_id: "psid-123",
    }),
    "Facebook Messenger: psid-123"
  );
  assert.equal(
    formatContactIdentifier({
      channel: "instagram",
      whatsapp_number: "instagram:igsid-456",
      channel_user_id: "igsid-456",
    }),
    "Instagram: igsid-456"
  );
});

test("social conversation summaries never render synthetic WhatsApp storage keys as phone numbers", () => {
  const text = buildConversationSummaryMessage({
    lead: {
      contact_id: 12,
      whatsapp_number: "facebook:psid-123",
      whatsapp_profile_name: null,
      name: "Facebook Lead",
      channel: "facebook",
      channel_user_id: "psid-123",
      stage_name: "New Lead",
      current_temperature: "warm",
      treatment_interest: "HIFU",
      branch_name: "Puchong",
      appointment_at: null,
      appointment_status: "none",
    },
    score,
  });

  assert.match(text, /Facebook Lead \(Facebook Messenger: psid-123\)/);
  assert.doesNotMatch(text, /\+123/);
});

test("social delivery-failure alerts name the correct channel", () => {
  const facebook = buildImmediateAlertMessage({
    type: "delivery_failure",
    context: {
      contact_id: 12,
      whatsapp_number: "facebook:psid-123",
      whatsapp_profile_name: null,
      name: "Facebook Lead",
      channel: "facebook",
      channel_user_id: "psid-123",
      temperature: "warm",
      stage_name: "New Lead",
      treatment_interest: "HIFU",
      branch_name: "Puchong",
      latest_customer_message: "Hello",
    },
    reason: "Delivery failed: outside reply window.",
  });

  assert.match(facebook, /⚠️ Facebook Messenger Delivery Failed/);
  assert.match(facebook, /Facebook Lead \(Facebook Messenger: psid-123\)/);
  assert.doesNotMatch(facebook, /WhatsApp Delivery Failed/);
});
