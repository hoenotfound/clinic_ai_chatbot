const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildConversationSummaryMessage,
  createTelegramAlertService,
  formatWhatsappNumber,
  isTelegramEnabled,
} = require("../src/services/telegramAlertService");

const lead = {
  alert_id: 31,
  lead_id: 7,
  id: 7,
  contact_id: 12,
  whatsapp_number: "60123456789",
  name: null,
  whatsapp_profile_name: "Kit Leong",
  stage_name: "Contacted",
  current_temperature: "warm",
  treatment_interest: null,
  branch_name: null,
  appointment_at: null,
};

const score = {
  temperature: "hot",
  confidence: "medium",
  reason: "Customer asked about booking but intent is not fully confirmed.",
  summary: {
    treatmentInterest: "HIFU",
    preferredBranch: "Puchong",
    preferredAppointment: "tomorrow afternoon",
    mainConcern: "Jawline sagging",
    chatSummary: "Customer asked about HIFU pricing and then asked about a possible booking tomorrow.",
    nextAction: "Confirm whether the customer wants an available appointment time.",
  },
};

test("Telegram alerts require the toggle, token, and chat id", () => {
  assert.equal(isTelegramEnabled({}), false);
  assert.equal(isTelegramEnabled({ TELEGRAM_ALERTS_ENABLED: "true" }), false);
  assert.equal(isTelegramEnabled({
    TELEGRAM_ALERTS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_CHAT_ID: "-1001",
  }), true);
});

test("formats Malaysian WhatsApp number for Telegram display", () => {
  assert.equal(formatWhatsappNumber("+60 12-345 6789"), "+60123456789");
});

test("shows pipeline temperature separately from the AI review", () => {
  const text = buildConversationSummaryMessage({
    lead,
    score,
    env: { PUBLIC_BASE_URL: "https://clinic.example.com/" },
  });

  assert.match(text, /🟠 Warm Conversation Summary/);
  assert.match(text, /Kit Leong \(\+60123456789\)/);
  assert.match(text, /Current Temperature: 🟠 Warm/);
  assert.match(text, /AI Review: 🔥 Hot \(medium confidence\)/);
  assert.match(text, /Treatment: HIFU/);
  assert.match(text, /Branch: Puchong/);
  assert.match(text, /Appointment: tomorrow afternoon/);
  assert.match(text, /Chat Summary:/);
  assert.match(text, /Inbox: https:\/\/clinic\.example\.com\/inbox\?contact=12/);
});

test("disabled service neither queues nor flushes Telegram summaries", async () => {
  let repositoryCalls = 0;
  let sends = 0;
  const repository = new Proxy({}, {
    get() {
      return async () => {
        repositoryCalls += 1;
      };
    },
  });
  const service = createTelegramAlertService({
    env: { TELEGRAM_ALERTS_ENABLED: "false" },
    repository,
    sendMessage: async () => {
      sends += 1;
    },
  });

  assert.deepEqual(
    await service.queueConversationSummary({ leadId: 7, throughMessageId: 44, score }),
    { status: "disabled" }
  );
  assert.deepEqual(
    await service.flushConversationSummaries({ inactivityMinutes: 10 }),
    { status: "disabled", sent: 0 }
  );
  assert.equal(repositoryCalls, 0);
  assert.equal(sends, 0);
});

test("enabled service stores the completed score snapshot in the durable queue", async () => {
  let queued = null;
  const service = createTelegramAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    repository: {
      queueSummary: async (input) => {
        queued = input;
        return { id: 31 };
      },
    },
  });

  const result = await service.queueConversationSummary({
    leadId: 7,
    throughMessageId: 44,
    score,
  });
  assert.deepEqual(queued, { leadId: 7, throughMessageId: 44, score });
  assert.deepEqual(result, { status: "queued", alertId: 31 });
});

test("flush rechecks inactivity at claim time and formats from the claimed snapshot", async () => {
  let findArgs = null;
  let claimArgs = null;
  let markedSentId = null;
  let sent = null;
  const env = {
    TELEGRAM_ALERTS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "-100123",
    PUBLIC_BASE_URL: "https://clinic.example.com",
  };
  const service = createTelegramAlertService({
    env,
    repository: {
      findReadySummaries: async (input) => {
        findArgs = input;
        return [{ alert_id: 31, lead_id: 7 }];
      },
      claimSummary: async (...args) => {
        claimArgs = args;
        return { ...lead, score_data: score };
      },
      markSent: async (id) => {
        markedSentId = id;
      },
      markFailed: async () => assert.fail("successful send should not be marked failed"),
    },
    sendMessage: async (input) => {
      sent = input;
      return { message_id: 99 };
    },
  });

  const result = await service.flushConversationSummaries({ inactivityMinutes: 10 });
  assert.deepEqual(findArgs, { inactivityMinutes: 10, limit: 5 });
  assert.deepEqual(claimArgs, [31, 10]);
  assert.equal(markedSentId, 31);
  assert.equal(sent.token, "bot-token");
  assert.equal(sent.chatId, "-100123");
  assert.match(sent.text, /Current Temperature: 🟠 Warm/);
  assert.deepEqual(result, { status: "completed", sent: 1 });
});

test("a candidate invalidated before claim is not sent", async () => {
  let sends = 0;
  const service = createTelegramAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    repository: {
      findReadySummaries: async () => [{ alert_id: 31, lead_id: 7 }],
      claimSummary: async () => null,
    },
    sendMessage: async () => {
      sends += 1;
    },
  });

  const result = await service.flushConversationSummaries({ inactivityMinutes: 10 });
  assert.equal(sends, 0);
  assert.deepEqual(result, { status: "completed", sent: 0 });
});

test("Telegram send failure is recorded for retry without aborting the flush", async (t) => {
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = () => {};

  let failure = null;
  const service = createTelegramAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    repository: {
      findReadySummaries: async () => [{ alert_id: 31, lead_id: 7 }],
      claimSummary: async () => ({ ...lead, score_data: score }),
      markSent: async () => assert.fail("failed send should not be marked sent"),
      markFailed: async (id, error) => {
        failure = { id, error };
      },
    },
    sendMessage: async () => {
      throw new Error("Telegram unavailable");
    },
  });

  const result = await service.flushConversationSummaries({ inactivityMinutes: 10 });
  assert.equal(failure.id, 31);
  assert.match(failure.error.message, /Telegram unavailable/);
  assert.deepEqual(result, { status: "completed", sent: 0 });
});
