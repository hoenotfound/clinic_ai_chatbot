const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildConversationSummaryMessage,
  createTelegramAlertService,
  formatWhatsappNumber,
  isTelegramEnabled,
} = require("../src/services/telegramAlertService");

const lead = {
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

test("disabled service does not query the database or call Telegram", async () => {
  let queries = 0;
  let sends = 0;
  const service = createTelegramAlertService({
    env: { TELEGRAM_ALERTS_ENABLED: "false" },
    getLeadContext: async () => {
      queries += 1;
      return lead;
    },
    sendMessage: async () => {
      sends += 1;
    },
  });

  const result = await service.sendConversationSummary({ leadId: 7, score });
  assert.deepEqual(result, { status: "disabled" });
  assert.equal(queries, 0);
  assert.equal(sends, 0);
});

test("enabled service loads lead details and sends exactly one Telegram message", async () => {
  let requestedLeadId = null;
  let sent = null;
  const env = {
    TELEGRAM_ALERTS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "-100123",
    PUBLIC_BASE_URL: "https://clinic.example.com",
  };
  const service = createTelegramAlertService({
    env,
    getLeadContext: async (leadId) => {
      requestedLeadId = leadId;
      return lead;
    },
    sendMessage: async (input) => {
      sent = input;
      return { message_id: 99 };
    },
  });

  const result = await service.sendConversationSummary({ leadId: 7, score });
  assert.equal(requestedLeadId, 7);
  assert.equal(sent.token, "bot-token");
  assert.equal(sent.chatId, "-100123");
  assert.match(sent.text, /Customer asked about HIFU pricing/);
  assert.deepEqual(result, { status: "sent", result: { message_id: 99 } });
});
