const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createWhatsAppDeliveryStatusService,
} = require("../src/services/whatsappDeliveryStatusService");

function job(overrides = {}) {
  return {
    id: 7,
    wamid: "wamid-status-1",
    delivery_status: "delivered",
    error_code: null,
    error_title: null,
    error_message: null,
    attempts: 1,
    ...overrides,
  };
}

function harness({ claimed = [], updateResult = null, existingMessage = null } = {}) {
  const calls = [];
  const repo = {
    storeBatch: async (updates) => {
      calls.push(["storeBatch", updates]);
      return updates;
    },
    claimByIds: async (ids) => {
      calls.push(["claimByIds", ids]);
      return claimed;
    },
    claimRecoverable: async () => [],
    listExhausted: async () => [],
    markCompleted: async (id) => {
      calls.push(["markCompleted", id]);
      return { id };
    },
    markFailed: async (id, err) => {
      calls.push(["markFailed", id, err.code || err.message]);
      return { id };
    },
    markTerminal: async (id) => {
      calls.push(["markTerminal", id]);
      return { id };
    },
    findMessageByWamid: async (wamid) => {
      calls.push(["findMessageByWamid", wamid]);
      return existingMessage;
    },
    setDeliveryAttentionState: async (contactId, reason) => {
      calls.push(["setDeliveryAttentionState", contactId, reason]);
      return { id: contactId };
    },
    pruneCompleted: async () => 0,
  };
  const messages = {
    updateDeliveryStatusByWamid: async (...args) => {
      calls.push(["updateDeliveryStatusByWamid", ...args]);
      return updateResult;
    },
  };
  const publish = (message) => calls.push(["publish", message.id]);
  const publishContact = (contactId) => calls.push(["publishContact", contactId]);
  const sendDeliveryFailureAlert = async (input) => {
    calls.push(["sendDeliveryFailureAlert", input.contactId, input.reason]);
    return { status: "sent" };
  };
  const logger = { error() {} };
  const service = createWhatsAppDeliveryStatusService({
    repo,
    messages,
    publish,
    publishContact,
    sendDeliveryFailureAlert,
    logger,
  });
  return { calls, repo, service };
}

test("live durable status is claimed, applied, published and completed", async () => {
  const statusJob = job();
  const updated = {
    id: 41,
    contact_id: 9,
    whatsapp_message_id: statusJob.wamid,
    delivery_status: "delivered",
    delivery_error: null,
  };
  const { calls, service } = harness({ claimed: [statusJob], updateResult: updated });

  await service.processStoredDeliveryStatuses([{ id: statusJob.id }]);

  assert.deepEqual(calls[0], ["claimByIds", [statusJob.id]]);
  assert.deepEqual(calls[1], [
    "updateDeliveryStatusByWamid",
    statusJob.wamid,
    "delivered",
    null,
  ]);
  assert.ok(calls.some((call) => call[0] === "publish" && call[1] === 41));
  assert.ok(calls.some((call) => call[0] === "markCompleted" && call[1] === statusJob.id));
  assert.equal(calls.some((call) => call[0] === "setDeliveryAttentionState"), false);
  assert.equal(calls.some((call) => call[0] === "sendDeliveryFailureAlert"), false);
});

test("callback that beats local WAMID persistence stays retryable", async () => {
  const statusJob = job({ id: 8, delivery_status: "sent" });
  const { calls, service } = harness({ claimed: [statusJob], updateResult: null, existingMessage: null });

  await service.processStoredDeliveryStatuses([{ id: statusJob.id }]);

  const failed = calls.find((call) => call[0] === "markFailed");
  assert.ok(failed);
  assert.equal(failed[1], statusJob.id);
  assert.equal(failed[2], "DELIVERY_STATUS_MESSAGE_NOT_LINKED");
  assert.equal(calls.some((call) => call[0] === "markCompleted"), false);
});

test("new failed status restores Inbox attention and sends one best-effort Telegram alert", async () => {
  const statusJob = job({
    id: 9,
    delivery_status: "failed",
    error_code: "131047",
    error_message: "Message failed at provider",
  });
  const updated = {
    id: 51,
    contact_id: 12,
    whatsapp_message_id: statusJob.wamid,
    delivery_status: "failed",
    delivery_error: statusJob.error_message,
  };
  const { calls, service } = harness({ claimed: [statusJob], updateResult: updated });

  await service.processStoredDeliveryStatuses([{ id: statusJob.id }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(calls.some((call) =>
    call[0] === "setDeliveryAttentionState" &&
    call[1] === 12 &&
    call[2] === "Delivery failed: Message failed at provider"
  ));
  assert.ok(calls.some((call) => call[0] === "publishContact" && call[1] === 12));
  assert.equal(calls.filter((call) => call[0] === "sendDeliveryFailureAlert").length, 1);
  assert.ok(calls.some((call) => call[0] === "markCompleted" && call[1] === statusJob.id));
});

test("replayed no-op failed status restores durable attention without duplicating Telegram", async () => {
  const statusJob = job({
    id: 10,
    delivery_status: "failed",
    error_code: "131047",
    error_message: "Message failed at provider",
  });
  const existing = {
    id: 52,
    contact_id: 12,
    whatsapp_message_id: statusJob.wamid,
    delivery_status: "failed",
    delivery_error: statusJob.error_message,
  };
  const { calls, service } = harness({ claimed: [statusJob], updateResult: null, existingMessage: existing });

  await service.processStoredDeliveryStatuses([{ id: statusJob.id }]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.ok(calls.some((call) =>
    call[0] === "setDeliveryAttentionState" &&
    call[1] === 12 &&
    call[2] === "Delivery failed: Message failed at provider"
  ));
  assert.equal(calls.some((call) => call[0] === "sendDeliveryFailureAlert"), false);
  assert.ok(calls.some((call) => call[0] === "markCompleted" && call[1] === statusJob.id));
});

test("exhausted failed job restores attention before terminal state", async () => {
  const exhaustedJob = job({
    id: 11,
    delivery_status: "failed",
    attempts: 5,
    error_message: "Permanent provider failure",
  });
  const existing = {
    id: 61,
    contact_id: 13,
    whatsapp_message_id: exhaustedJob.wamid,
    delivery_status: "failed",
    delivery_error: exhaustedJob.error_message,
  };
  const { calls, repo, service } = harness({ existingMessage: existing });
  repo.listExhausted = async () => [exhaustedJob];

  await service.runRecovery();

  const attentionIndex = calls.findIndex((call) => call[0] === "setDeliveryAttentionState");
  const terminalIndex = calls.findIndex((call) => call[0] === "markTerminal");
  assert.ok(attentionIndex >= 0);
  assert.ok(terminalIndex > attentionIndex, "attention must be durable before terminalizing the job");
  assert.equal(calls.some((call) => call[0] === "sendDeliveryFailureAlert"), false);
});

test("exhausted failed job stays non-terminal when attention restoration fails", async () => {
  const exhaustedJob = job({
    id: 12,
    delivery_status: "failed",
    attempts: 5,
    error_message: "Permanent provider failure",
  });
  const existing = {
    id: 62,
    contact_id: 14,
    whatsapp_message_id: exhaustedJob.wamid,
    delivery_status: "failed",
    delivery_error: exhaustedJob.error_message,
  };
  const { calls, repo, service } = harness({ existingMessage: existing });
  repo.listExhausted = async () => [exhaustedJob];
  repo.setDeliveryAttentionState = async () => {
    calls.push(["setDeliveryAttentionState", 14]);
    throw new Error("database unavailable");
  };

  await service.runRecovery();

  assert.ok(calls.some((call) => call[0] === "setDeliveryAttentionState"));
  assert.equal(calls.some((call) => call[0] === "markTerminal"), false);
});

test("recovery claims retryable work and terminalizes exhausted non-failure rows", async () => {
  const retryJob = job({ id: 13, delivery_status: "read", attempts: 2 });
  const exhaustedJob = job({ id: 14, delivery_status: "delivered", attempts: 5 });
  const { calls, repo, service } = harness({
    updateResult: {
      id: 63,
      contact_id: 15,
      whatsapp_message_id: retryJob.wamid,
      delivery_status: "read",
      delivery_error: null,
    },
  });
  repo.claimRecoverable = async () => [retryJob];
  repo.listExhausted = async () => [exhaustedJob];

  await service.runRecovery();

  assert.ok(calls.some((call) => call[0] === "markCompleted" && call[1] === retryJob.id));
  assert.ok(calls.some((call) => call[0] === "markTerminal" && call[1] === exhaustedJob.id));
});
