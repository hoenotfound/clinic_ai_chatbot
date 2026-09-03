const test = require("node:test");
const assert = require("node:assert/strict");

const {
  bookingReadyEventKey,
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
  treatment_interest: "HIFU",
  branch_name: "Puchong",
  stage_name: "Contacted",
  latest_customer_message_id: 777,
  latest_customer_message: "Puchong, Saturday afternoon works for me",
};

test("booking-ready Telegram key is stable for the triggering inbound message", () => {
  assert.equal(bookingReadyEventKey(context, 777), "booking-ready:42:777");
});

test("booking-ready Telegram message is distinct from human escalation", () => {
  const text = buildImmediateAlertMessage({
    type: "booking_ready",
    context,
    reason: "Booking ready: customer provided scheduling preferences; staff should confirm availability.",
    env: { PUBLIC_BASE_URL: "https://clinic.example" },
  });

  assert.match(text, /^🔥 Booking Ready/);
  assert.match(text, /Temperature: 🔥 Hot/i);
  assert.match(text, /Branch: Puchong/);
  assert.match(text, /confirm the appointment availability/i);
  assert.doesNotMatch(text, /Human Intervention Required/);
});

test("booking-ready notification is claimed once using its own alert type", async () => {
  const claims = [];
  const sent = [];
  const service = createTelegramImmediateAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "test-token",
      TELEGRAM_CHAT_ID: "test-chat",
      PUBLIC_BASE_URL: "https://clinic.example",
    },
    async getContext() {
      return context;
    },
    async claimAlert(input) {
      claims.push(input);
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
    reason: "Ready for staff confirmation.",
  });

  assert.equal(result.status, "sent");
  assert.deepEqual(claims, [
    {
      eventKey: "booking-ready:42:777",
      type: "booking_ready",
      contactId: 42,
    },
  ]);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /^🔥 Booking Ready/);
});
