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
    markTerminal: async (id) => ({ id }),
    findMessageByWamid: async (wamid) => {
      calls.push(["findMessageByWamid", wamid]);
      return existingMessage;
    },
    pruneCompleted: async () => 0,
  };
  const messages = {
    updateDeliveryStatusByWamid: async (...args) => {
      calls.push(["updateDeliveryStatusByWamid", ...args]);
      return updateResult;
    },
  };
  const contacts = {
    setDeliveryAttention: async (...args) => calls.push(["setDeliveryAttention", ...args]),
  };
  const publish = (message) => calls.push(["publish", message.id]);
  const logger = { error() {} };
  const service = createWhatsAppDeliveryStatusService({ repo, messages, contacts, publish, logger });
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
  assert.equal(calls.some((call) => call[0] === "setDeliveryAttention"), false);
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

test("replayed no-op failed status still restores staff attention before completion", async () => {
  const statusJob = job({
    id: 9,
    delivery_status: "failed",
    error_code: "131047",
    error_message: "Message failed at provider",
  });
  const existing = {
    id: 51,
    contact_id: 12,
    whatsapp_message_id: statusJob.wamid,
    delivery_status: "failed",
    delivery_error: statusJob.error_message,
  };
  const { calls, service } = harness({ claimed: [statusJob], updateResult: null, existingMessage: existing });

  await service.processStoredDeliveryStatuses([{ id: statusJob.id }]);

  assert.ok(calls.some((call) =>
    call[0] === "setDeliveryAttention" &&
    call[1] === 12 &&
    call[2] === "Delivery failed: Message failed at provider"
  ));
  assert.ok(calls.some((call) => call[0] === "markCompleted" && call[1] === statusJob.id));
});

test("recovery claims retryable work and leaves exhausted rows terminal", async () => {
  const retryJob = job({ id: 10, delivery_status: "read", attempts: 2 });
  const exhaustedJob = job({ id: 11, delivery_status: "delivered", attempts: 5 });
  const { calls, repo, service } = harness({
    updateResult: {
      id: 61,
      contact_id: 13,
      whatsapp_message_id: retryJob.wamid,
      delivery_status: "read",
      delivery_error: null,
    },
  });
  repo.claimRecoverable = async () => [retryJob];
  repo.listExhausted = async () => [exhaustedJob];
  repo.markTerminal = async (id) => {
    calls.push(["markTerminal", id]);
    return { id, terminal_at: new Date() };
  };

  await service.runRecovery();

  assert.ok(calls.some((call) => call[0] === "markCompleted" && call[1] === retryJob.id));
  assert.ok(calls.some((call) => call[0] === "markTerminal" && call[1] === exhaustedJob.id));
});
