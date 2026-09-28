const test = require("node:test");
const assert = require("node:assert/strict");

const {
  HUMAN_ALERT_COOLDOWN_MINUTES,
  IMMEDIATE_ALERT_RETRY_DELAYS_MS,
  buildImmediateAlertMessage,
  createImmediateAlertQueueRunner,
  createTelegramImmediateAlertService,
  delayUntilNextImmediateAlert,
  humanInterventionEventKey,
  retryDelayMsForAttempt,
  shouldSendImmediateAlert,
  staffWaitingReference,
} = require("../src/services/telegramImmediateAlertService");

const context = {
  contact_id: 12,
  whatsapp_number: "60123456789",
  name: null,
  whatsapp_profile_name: "Kit Leong",
  channel: "whatsapp",
  channel_user_id: null,
  temperature: "hot",
  stage_name: "Contacted",
  treatment_interest: "HIFU",
  branch_name: "Puchong",
  latest_customer_message_id: 44,
  latest_customer_message: "Can someone help me book for Saturday?",
};

const enabledEnv = {
  TELEGRAM_ALERTS_ENABLED: "true",
  TELEGRAM_BOT_TOKEN: "bot-token",
  TELEGRAM_CHAT_ID: "-100123",
  PUBLIC_BASE_URL: "https://clinic.example.com",
};

test("formats human intervention and delivery failure alerts", () => {
  const human = buildImmediateAlertMessage({
    type: "human_intervention",
    context,
    reason: "AI handed off this conversation.",
    env: enabledEnv,
  });
  assert.match(human, /🚨 Human Intervention Required/);
  assert.match(human, /AI handed off this conversation/);
  assert.match(human, /🔥 Hot/);
  assert.match(human, /Latest Patient Message:/);
  assert.doesNotMatch(human, /Latest Customer Message:/);
  assert.match(human, /inbox\?contact=12/);

  const delivery = buildImmediateAlertMessage({
    type: "delivery_failure",
    context,
    reason: "Delivery failed: Meta rejected the message.",
    env: {},
  });
  assert.match(delivery, /⚠️ WhatsApp Delivery Failed/);
  assert.match(delivery, /Check the failed message in Inbox/);
  assert.match(delivery, /contact the patient manually\./);
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

test("staff-waiting event keys identify the exact unanswered episode for send-time revalidation", async () => {
  const alert = {
    alert_type: "staff_waiting",
    event_key: "staff_waiting:12:45",
    contact_id: 12,
  };
  assert.deepEqual(staffWaitingReference(alert), {
    contactId: 12,
    waitingMessageId: 45,
  });
  assert.equal(
    staffWaitingReference({ ...alert, event_key: "staff_waiting:13:45" }),
    null
  );
  assert.equal(
    staffWaitingReference({ ...alert, event_key: "staff_waiting:bad:key" }),
    null
  );

  let captured = null;
  const stillWaiting = await shouldSendImmediateAlert(
    alert,
    async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ waiting: true }] };
    }
  );
  assert.equal(stillWaiting, true);
  assert.deepEqual(captured.params, [12, 45]);
  assert.match(captured.sql, /sent_by_username IS NOT NULL/);
  assert.match(captured.sql, /delivery_status NOT IN \('failed', 'unknown'\)/);
});

test("resolved staff-waiting retry is cancelled before Telegram is called", async () => {
  const calls = [];
  let sends = 0;
  const repository = {
    async markExhaustedStale() {
      calls.push(["markExhaustedStale"]);
      return [];
    },
    async claimReady() {
      calls.push(["claimReady"]);
      return [{
        id: 77,
        event_key: "staff_waiting:12:45",
        contact_id: 12,
        alert_type: "staff_waiting",
        message_text: "Customer is waiting",
        attempts: 2,
        lease_token: "lease-waiting",
      }];
    },
    async markCancelled(id, leaseToken, reason) {
      calls.push(["markCancelled", id, leaseToken, reason]);
      return { id, status: "cancelled" };
    },
    async markSent() {
      throw new Error("resolved reminder must not be marked sent");
    },
    async markFailed() {
      throw new Error("resolved reminder must not be retried");
    },
    async findNextDueAt() {
      calls.push(["findNextDueAt"]);
      return null;
    },
  };

  const run = createImmediateAlertQueueRunner({
    env: enabledEnv,
    repository,
    shouldSendAlert: async (alert) => {
      assert.equal(alert.event_key, "staff_waiting:12:45");
      return false;
    },
    async sendMessage() {
      sends += 1;
    },
  });

  const result = await run();

  assert.equal(sends, 0);
  assert.deepEqual(result, {
    claimedCount: 1,
    sentCount: 0,
    failedCount: 0,
    nextDueAt: null,
  });
  assert.deepEqual(calls, [
    ["markExhaustedStale"],
    ["claimReady"],
    [
      "markCancelled",
      77,
      "lease-waiting",
      "Staff-waiting reminder resolved before Telegram delivery.",
    ],
    ["findNextDueAt"],
  ]);
});

test("disabled immediate alerts do not load context or touch the queue", async () => {
  let contextCalls = 0;
  let queueCalls = 0;
  const service = createTelegramImmediateAlertService({
    env: { TELEGRAM_ALERTS_ENABLED: "false" },
    getContext: async () => {
      contextCalls += 1;
      return context;
    },
    repository: {
      queueAlert: async () => {
        queueCalls += 1;
      },
    },
  });

  assert.deepEqual(
    await service.sendHumanInterventionAlert({ contactId: 12, reason: "Help" }),
    { status: "disabled" }
  );
  assert.equal(contextCalls, 0);
  assert.equal(queueCalls, 0);
});

test("delivery failures are durably queued with the rendered alert text", async () => {
  const queued = [];
  let wakes = 0;
  const service = createTelegramImmediateAlertService({
    env: enabledEnv,
    getContext: async (contactId) => {
      assert.equal(contactId, 12);
      return context;
    },
    repository: {
      async queueAlert(input) {
        queued.push(input);
        return { id: 88 };
      },
    },
    wakeQueue(delayMs) {
      assert.equal(delayMs, 0);
      wakes += 1;
    },
  });

  const result = await service.sendDeliveryFailureAlert({
    contactId: 12,
    reason: "Delivery failed: outside reply window.",
  });

  assert.deepEqual(result, { status: "queued", alertId: 88 });
  assert.equal(wakes, 1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].type, "delivery_failure");
  assert.equal(queued[0].contactId, 12);
  assert.equal(queued[0].cooldownMinutes, 0);
  assert.match(queued[0].eventKey, /^delivery:12:event:/);
  assert.match(queued[0].messageText, /outside reply window/);
});

test("human interventions keep the 30-minute cooldown while queueing instead of sending inline", async () => {
  const queued = [];
  let queueCount = 0;
  const service = createTelegramImmediateAlertService({
    env: enabledEnv,
    getContext: async () => context,
    repository: {
      async queueAlert(input) {
        queued.push(input);
        queueCount += 1;
        return queueCount === 1 ? { id: 91 } : null;
      },
    },
    wakeQueue() {},
  });

  const first = await service.sendHumanInterventionAlert({
    contactId: 12,
    messageId: 44,
    reason: "AI handed off this conversation.",
  });
  const second = await service.sendHumanInterventionAlert({
    contactId: 12,
    messageId: 45,
    reason: "New message — conversation is staff-owned.",
  });

  assert.deepEqual(first, { status: "queued", alertId: 91 });
  assert.deepEqual(second, { status: "suppressed" });
  assert.equal(queued[0].eventKey, "human:12:44");
  assert.equal(queued[0].cooldownMinutes, HUMAN_ALERT_COOLDOWN_MINUTES);
  assert.equal(queued[1].eventKey, "human:12:45");
});

test("immediate queue runner sends claimed rows and marks them sent", async () => {
  const calls = [];
  const repository = {
    async markExhaustedStale() {
      calls.push(["markExhaustedStale"]);
      return [];
    },
    async claimReady() {
      calls.push(["claimReady"]);
      return [{
        id: 7,
        contact_id: 12,
        alert_type: "human_intervention",
        message_text: "queued text",
        attempts: 1,
        lease_token: "lease-1",
      }];
    },
    async markSent(id, leaseToken) {
      calls.push(["markSent", id, leaseToken]);
      return { id };
    },
    async markFailed() {
      throw new Error("should not fail");
    },
    async findNextDueAt() {
      calls.push(["findNextDueAt"]);
      return null;
    },
  };
  const sent = [];
  const run = createImmediateAlertQueueRunner({
    env: enabledEnv,
    repository,
    async sendMessage(input) {
      sent.push(input);
      return { message_id: 99 };
    },
  });

  const result = await run();

  assert.deepEqual(result, {
    claimedCount: 1,
    sentCount: 1,
    failedCount: 0,
    nextDueAt: null,
  });
  assert.deepEqual(sent, [{
    token: "bot-token",
    chatId: "-100123",
    text: "queued text",
  }]);
  assert.deepEqual(calls, [
    ["markExhaustedStale"],
    ["claimReady"],
    ["markSent", 7, "lease-1"],
    ["findNextDueAt"],
  ]);
});

test("Telegram timeout stays queued with backoff instead of being lost", async (t) => {
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = () => {};

  const failures = [];
  const repository = {
    async markExhaustedStale() {
      return [];
    },
    async claimReady() {
      return [{
        id: 8,
        contact_id: 12,
        alert_type: "booking_ready",
        message_text: "retry me",
        attempts: 1,
        lease_token: "lease-2",
      }];
    },
    async markSent() {
      throw new Error("should not mark sent");
    },
    async markFailed(id, leaseToken, err, options) {
      failures.push({ id, leaseToken, message: err.message, options });
      return { id, status: "pending" };
    },
    async findNextDueAt() {
      return "2026-09-28T23:00:00.000Z";
    },
  };
  const run = createImmediateAlertQueueRunner({
    env: enabledEnv,
    repository,
    async sendMessage() {
      throw new Error("Telegram send timed out.");
    },
  });

  const result = await run();

  assert.equal(result.claimedCount, 1);
  assert.equal(result.sentCount, 0);
  assert.equal(result.failedCount, 1);
  assert.equal(result.nextDueAt, "2026-09-28T23:00:00.000Z");
  assert.deepEqual(failures, [{
    id: 8,
    leaseToken: "lease-2",
    message: "Telegram send timed out.",
    options: { retryDelaySeconds: 60 },
  }]);
});

test("immediate retry schedule is bounded and adaptive", () => {
  assert.deepEqual(IMMEDIATE_ALERT_RETRY_DELAYS_MS, [
    60_000,
    120_000,
    300_000,
    900_000,
  ]);
  assert.equal(retryDelayMsForAttempt(1), 60_000);
  assert.equal(retryDelayMsForAttempt(2), 120_000);
  assert.equal(retryDelayMsForAttempt(3), 300_000);
  assert.equal(retryDelayMsForAttempt(4), 900_000);
  assert.equal(retryDelayMsForAttempt(99), 900_000);
  assert.equal(delayUntilNextImmediateAlert({ nextDueAt: null }), null);
});
