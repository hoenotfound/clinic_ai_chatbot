const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildImmediateAlertMessage,
  createTelegramImmediateAlertService,
  humanInterventionEventKey,
} = require("../src/services/telegramImmediateAlertService");

const context = {
  contact_id: 12,
  whatsapp_number: "60123456789",
  name: null,
  whatsapp_profile_name: "Kit Leong",
  temperature: "hot",
  stage_name: "Contacted",
  treatment_interest: "HIFU",
  branch_name: "Puchong",
  latest_customer_message_id: 44,
  latest_customer_message: "Can someone help me book for Saturday?",
};

test("formats human intervention and delivery failure alerts", () => {
  const human = buildImmediateAlertMessage({
    type: "human_intervention",
    context,
    reason: "AI handed off this conversation.",
    env: { PUBLIC_BASE_URL: "https://clinic.example.com" },
  });
  assert.match(human, /🚨 Human Intervention Required/);
  assert.match(human, /AI handed off this conversation/);
  assert.match(human, /🔥 Hot/);
  assert.match(human, /Latest Customer Message:/);
  assert.match(human, /inbox\?contact=12/);

  const delivery = buildImmediateAlertMessage({
    type: "delivery_failure",
    context,
    reason: "Delivery failed: Meta rejected the message.",
    env: {},
  });
  assert.match(delivery, /⚠️ WhatsApp Delivery Failed/);
  assert.match(delivery, /Check the failed message in Inbox/);
});

test("missing lead temperature is not mislabeled as warm", () => {
  const text = buildImmediateAlertMessage({
    type: "human_intervention",
    context: { ...context, temperature: null },
    reason: "Needs review",
    env: {},
  });
  assert.match(text, /Temperature: Not captured/);
  assert.doesNotMatch(text, /Temperature: 🟠 Warm/);
});

test("automated human alerts for the same inbound customer message share one event key", () => {
  assert.equal(
    humanInterventionEventKey(context, "Message may need human attention (auto-detected keyword)."),
    "human:12:44"
  );
  assert.equal(
    humanInterventionEventKey(context, "AI handed off this conversation."),
    "human:12:44"
  );
  assert.equal(humanInterventionEventKey(context, "Flagged by staff."), null);
});

test("disabled immediate alerts do not load context or send", async () => {
  let contextCalls = 0;
  let sends = 0;
  const service = createTelegramImmediateAlertService({
    env: { TELEGRAM_ALERTS_ENABLED: "false" },
    getContext: async () => {
      contextCalls += 1;
      return context;
    },
    sendMessage: async () => {
      sends += 1;
    },
  });

  assert.deepEqual(
    await service.sendHumanInterventionAlert({ contactId: 12, reason: "Help" }),
    { status: "disabled" }
  );
  assert.equal(contextCalls, 0);
  assert.equal(sends, 0);
});

test("enabled immediate alerts send to the configured Telegram group", async () => {
  let sent = null;
  const env = {
    TELEGRAM_ALERTS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "-100123",
    PUBLIC_BASE_URL: "https://clinic.example.com",
  };
  const service = createTelegramImmediateAlertService({
    env,
    getContext: async (contactId) => {
      assert.equal(contactId, 12);
      return context;
    },
    claimAlert: async () => true,
    sendMessage: async (input) => {
      sent = input;
      return { message_id: 88 };
    },
  });

  const result = await service.sendDeliveryFailureAlert({
    contactId: 12,
    reason: "Delivery failed: outside reply window.",
  });

  assert.equal(sent.token, "bot-token");
  assert.equal(sent.chatId, "-100123");
  assert.match(sent.text, /outside reply window/);
  assert.deepEqual(result, { status: "sent", result: { message_id: 88 } });
});

test("duplicate human intervention paths for the same customer message send only once", async () => {
  const env = {
    TELEGRAM_ALERTS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "-100123",
  };
  const claimedKeys = new Set();
  let sends = 0;
  const service = createTelegramImmediateAlertService({
    env,
    getContext: async () => context,
    claimAlert: async ({ eventKey }) => {
      if (claimedKeys.has(eventKey)) return false;
      claimedKeys.add(eventKey);
      return true;
    },
    sendMessage: async () => {
      sends += 1;
      return { message_id: sends };
    },
  });

  const first = await service.sendHumanInterventionAlert({
    contactId: 12,
    reason: "Message may need human attention (auto-detected keyword).",
  });
  const second = await service.sendHumanInterventionAlert({
    contactId: 12,
    reason: "AI handed off this conversation.",
  });

  assert.equal(first.status, "sent");
  assert.deepEqual(second, { status: "duplicate" });
  assert.equal(sends, 1);
});
