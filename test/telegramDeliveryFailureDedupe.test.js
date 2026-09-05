const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createTelegramImmediateAlertService,
  deliveryFailureEventKey,
} = require("../src/services/telegramImmediateAlertService");

const context = {
  contact_id: 12,
  whatsapp_number: "60123456789",
  name: "Test contact",
  channel: "whatsapp",
  temperature: "warm",
  stage_name: "Contacted",
  treatment_interest: "HIFU",
  branch_name: "Puchong",
  latest_customer_message_id: 44,
  latest_customer_message: "hello",
  latest_failed_outbound_message_id: 91,
};

test("delivery failure replay uses the failed outbound message as its stable alert key", () => {
  assert.equal(
    deliveryFailureEventKey(context),
    "delivery-failure:12:91"
  );
  assert.equal(
    deliveryFailureEventKey({ ...context, latest_failed_outbound_message_id: null }),
    null
  );
});

test("replayed durable delivery failure is suppressed after its first Telegram claim", async () => {
  const env = {
    TELEGRAM_ALERTS_ENABLED: "true",
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_CHAT_ID: "-100123",
  };
  const claimedKeys = [];
  let sends = 0;
  const service = createTelegramImmediateAlertService({
    env,
    getContext: async () => context,
    claimAlert: async ({ eventKey, type, contactId }) => {
      assert.equal(type, "delivery_failure");
      assert.equal(contactId, 12);
      claimedKeys.push(eventKey);
      return claimedKeys.length === 1;
    },
    sendMessage: async () => {
      sends += 1;
      return { message_id: sends };
    },
  });

  const first = await service.sendDeliveryFailureAlert({
    contactId: 12,
    reason: "Delivery failed: provider rejected message.",
  });
  const replay = await service.sendDeliveryFailureAlert({
    contactId: 12,
    reason: "Delivery failed: provider rejected message.",
  });

  assert.equal(first.status, "sent");
  assert.deepEqual(replay, { status: "suppressed" });
  assert.deepEqual(claimedKeys, [
    "delivery-failure:12:91",
    "delivery-failure:12:91",
  ]);
  assert.equal(sends, 1);
});

test("delivery alerts without a failed outbound row keep legacy best-effort behavior", async () => {
  let claims = 0;
  let sends = 0;
  const service = createTelegramImmediateAlertService({
    env: {
      TELEGRAM_ALERTS_ENABLED: "true",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELEGRAM_CHAT_ID: "-100123",
    },
    getContext: async () => ({
      ...context,
      latest_failed_outbound_message_id: null,
    }),
    claimAlert: async () => {
      claims += 1;
      return true;
    },
    sendMessage: async () => {
      sends += 1;
      return { message_id: sends };
    },
  });

  const result = await service.sendDeliveryFailureAlert({
    contactId: 12,
    reason: "Delivery failed: no message row available.",
  });

  assert.equal(result.status, "sent");
  assert.equal(claims, 0);
  assert.equal(sends, 1);
});
