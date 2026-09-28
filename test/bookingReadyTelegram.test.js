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
    details: {
      staffSummary: "Customer wants HIFU at Puchong and prefers Saturday afternoon. Staff should confirm an available slot.",
    },
    env: { PUBLIC_BASE_URL: "https://clinic.example" },
  });

  assert.match(text, /^🔥 Booking Ready/);
  assert.match(text, /Temperature: 🔥 Hot/i);
  assert.match(text, /Branch: Puchong/);
  assert.match(text, /AI Summary:/);
  assert.match(text, /Customer wants HIFU at Puchong and prefers Saturday afternoon/);
  assert.match(text, /confirm the appointment availability/i);
  assert.doesNotMatch(text, /Human Intervention Required/);
});

test("booking-ready notification is durably queued once using its own alert type", async () => {
  const queued = [];
  let wakes = 0;
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
    repository: {
      async queueAlert(input) {
        queued.push(input);
        return { id: 123 };
      },
    },
    wakeQueue() {
      wakes += 1;
    },
  });

  const result = await service.sendBookingReadyAlert({
    contactId: 42,
    messageId: 777,
    reason: "Ready for staff confirmation.",
  });

  assert.deepEqual(result, { status: "queued", alertId: 123 });
  assert.equal(wakes, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].eventKey, "booking-ready:42:777");
  assert.equal(queued[0].type, "booking_ready");
  assert.equal(queued[0].contactId, 42);
  assert.match(queued[0].messageText, /^🔥 Booking Ready/);
});
