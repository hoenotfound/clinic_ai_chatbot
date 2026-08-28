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
  treatment_interest: null,
  branch_name: null,
  appointment_at: null,
};

const score = {
  temperature: "hot",
  confidence: "high",
  reason: "Customer asked to book tomorrow.",
  summary: {
    treatmentInterest: "HIFU",
    preferredBranch: "Puchong",
    preferredAppointment: "tomorrow afternoon",
    mainConcern: "Jawline sagging",
    chatSummary: "Customer asked about HIFU pricing and then requested a booking tomorrow.",
    nextAction: "Confirm the available appointment time.",
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

test("builds a concise summary with a direct Inbox link", () => {
  const text = buildConversationSummaryMessage({
    lead,
    score,
    env: { PUBLIC_BASE_URL: "https://clinic.example.com/" },
  });

  assert.match(text, /🔥 Hot Conversation Summary/);
  assert.match(text, /Kit Leong \(\+60123456789\)/);
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

test("flush sends only repository-approved inactive snapshots and marks them sent", async () => {
  let findArgs = null;
  let claimedId = null;
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
        return [{ ...lead, score_data: score }];
      },
      claimSummary: async (id) => {
        claimedId = id;
        return { id };
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
  assert.equal(claimedId, 31);
  assert.equal(markedSentId, 31);
  assert.equal(sent.token, "bot-token");
  assert.equal(sent.chatId, "-100123");
  assert.match(sent.text, /Customer asked about HIFU pricing/);
  assert.deepEqual(result, { status: "completed", sent: 1 });
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
      findReadySummaries: async () => [{ ...lead, score_data: score }],
      claimSummary: async () => ({ id: 31 }),
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
