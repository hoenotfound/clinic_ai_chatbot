const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_RETRY_ATTEMPTS,
  runWhatsappOutboundRetryQueue,
} = require("../src/services/whatsappOutboundRetryService");

function baseRow(overrides = {}) {
  return {
    id: 1,
    message_id: 10,
    contact_id: 20,
    recipient: "60123456789",
    origin: "ai_reply",
    status: "processing",
    attempts: 1,
    lease_token: "lease-1",
    message_content: "Hello",
    delivery_status: "failed",
    whatsapp_message_id: null,
    contact_mode: "ai",
    contact_channel: "whatsapp",
    current_recipient: "60123456789",
    contact_needs_attention: false,
    has_newer_customer_message: false,
    has_newer_staff_message: false,
    ...overrides,
  };
}

test("transient WhatsApp retry is rescheduled without alerting staff", async () => {
  const calls = [];
  const repository = {
    async recoverStaleProcessing() { return []; },
    async claimDue() { return [baseRow()]; },
    async reschedule(id, lease, input) {
      calls.push(["reschedule", id, lease, input]);
    },
    async findNextDueAt() { return null; },
  };
  const messages = {
    async setDeliveryStatusById(id, status, error) {
      calls.push(["message", id, status, error]);
      return { id, contact_id: 20, delivery_status: status, delivery_error: error };
    },
  };
  const contacts = {
    async setDeliveryAttention() {
      throw new Error("transient retry must not alert staff yet");
    },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    messages,
    contacts,
    async sendMessage() {
      return {
        success: false,
        wamid: null,
        retryable: true,
        ambiguous: false,
        error: "Meta busy",
        providerStatus: 500,
        providerErrorCode: 131000,
      };
    },
  });

  assert.equal(calls[0][0], "message");
  assert.equal(calls[1][0], "reschedule");
  assert.equal(calls[1][3].providerErrorCode, 131000);
});

test("successful retry attaches the new WAMID to the original message", async () => {
  const calls = [];
  const repository = {
    async recoverStaleProcessing() { return []; },
    async claimDue() { return [baseRow()]; },
    async markSent(id, lease) { calls.push(["sent", id, lease]); },
    async findNextDueAt() { return null; },
  };
  const messages = {
    async setWhatsappMessageId(id, wamid) {
      calls.push(["wamid", id, wamid]);
      return { id, contact_id: 20, whatsapp_message_id: wamid, delivery_status: "pending" };
    },
  };
  const contacts = {
    async clearDeliveryAttentionIfNoFailedMessages(id) {
      calls.push(["clear", id]);
    },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    messages,
    contacts,
    evidence: {
      async recordOutcome(input) {
        calls.push(["evidence", input.messageId, input.accepted, input.providerMessageId]);
      },
    },
    async sendMessage() {
      return { success: true, wamid: "wamid.retry-success" };
    },
  });

  assert.deepEqual(calls[0], ["wamid", 10, "wamid.retry-success"]);
  assert.deepEqual(calls[1], ["sent", 1, "lease-1"]);
  assert.deepEqual(calls[2], ["evidence", 10, true, "wamid.retry-success"]);
  assert.deepEqual(calls[3], ["clear", 20]);
});

test("ambiguous retry never resends automatically", async () => {
  const calls = [];
  const repository = {
    async recoverStaleProcessing() { return []; },
    async claimDue() { return [baseRow()]; },
    async markFailed(id, lease, error) { calls.push(["failed", id, lease, error]); },
    async findNextDueAt() { return null; },
  };
  const messages = {
    async setDeliveryStatusById(id, status, error) {
      calls.push(["message", id, status, error]);
      return { id, contact_id: 20, delivery_status: status, delivery_error: error };
    },
  };
  const contacts = {
    async setDeliveryAttention(id, reason) {
      calls.push(["attention", id, reason]);
    },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    messages,
    contacts,
    async sendMessage() {
      return {
        success: false,
        wamid: null,
        ambiguous: true,
        retryable: false,
        error: "network timeout",
      };
    },
  });

  assert.equal(calls[0][2], "unknown");
  assert.equal(calls[1][0], "attention");
  assert.equal(calls[2][0], "failed");
});

test("retry exhaustion alerts staff instead of scheduling attempt four", async () => {
  const calls = [];
  const repository = {
    async recoverStaleProcessing() { return []; },
    async claimDue() { return [baseRow({ attempts: MAX_RETRY_ATTEMPTS })]; },
    async markFailed(id, lease, error) { calls.push(["failed", id, lease, error]); },
    async reschedule() { throw new Error("must not reschedule exhausted retry"); },
    async findNextDueAt() { return null; },
  };
  const messages = {
    async setDeliveryStatusById(id, status, error) {
      calls.push(["message", id, status, error]);
      return { id, contact_id: 20, delivery_status: status, delivery_error: error };
    },
  };
  const contacts = {
    async setDeliveryAttention(id, reason) {
      calls.push(["attention", id, reason]);
    },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    messages,
    contacts,
    async sendMessage() {
      return {
        success: false,
        retryable: true,
        ambiguous: false,
        error: "still unavailable",
        providerStatus: 503,
      };
    },
  });

  assert.equal(calls.some((entry) => entry[0] === "failed"), true);
  assert.equal(calls.some((entry) => entry[0] === "attention"), true);
});


test("stale retry with no provider evidence is surfaced as unconfirmed exactly once", async () => {
  const calls = [];
  const stale = baseRow({
    lease_token: "recovered-lease",
    delivery_status: "failed",
    last_error: "server restarted",
  });
  const repository = {
    async recoverStaleProcessing() { return [stale]; },
    async claimDue() { return []; },
    async markFailed(id, lease, error) {
      calls.push(["failed", id, lease, error]);
    },
    async findNextDueAt() { return null; },
  };
  const messages = {
    async setDeliveryStatusById(id, status, error) {
      calls.push(["message", id, status, error]);
      return { id, contact_id: 20, delivery_status: status, delivery_error: error };
    },
  };
  const contacts = {
    async setDeliveryAttention(id, reason) {
      calls.push(["attention", id, reason]);
    },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    messages,
    contacts,
    async sendMessage() {
      throw new Error("stale retry must never call Meta again");
    },
  });

  assert.equal(calls[0][2], "unknown");
  assert.equal(calls[1][0], "attention");
  assert.deepEqual(calls[2].slice(0, 3), ["failed", 1, "recovered-lease"]);
});

test("stale retry with a durable WAMID is completed without resending", async () => {
  const calls = [];
  const stale = baseRow({
    lease_token: "recovered-accepted-lease",
    whatsapp_message_id: "wamid.already-accepted",
    delivery_status: "pending",
  });
  const repository = {
    async recoverStaleProcessing() { return [stale]; },
    async claimDue() { return []; },
    async markSent(id, lease) { calls.push(["sent", id, lease]); },
    async findNextDueAt() { return null; },
  };
  const contacts = {
    async clearDeliveryAttentionIfNoFailedMessages(id) {
      calls.push(["clear", id]);
    },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    messages: {},
    contacts,
    evidence: {
      async recordOutcome(input) {
        calls.push(["evidence", input.messageId, input.providerMessageId]);
      },
    },
    async sendMessage() {
      throw new Error("durably accepted retry must never be resent");
    },
  });

  assert.deepEqual(calls, [
    ["sent", 1, "recovered-accepted-lease"],
    ["evidence", 10, "wamid.already-accepted"],
    ["clear", 20],
  ]);
});

test("provider acceptance without durable WAMID persistence fails closed", async () => {
  const calls = [];
  const repository = {
    async recoverStaleProcessing() { return []; },
    async claimDue() { return [baseRow()]; },
    async markFailed(id, lease, error) {
      calls.push(["failed", id, lease, error]);
    },
    async findNextDueAt() { return null; },
  };
  let writeCount = 0;
  const messages = {
    async setWhatsappMessageId() {
      return null;
    },
    async setDeliveryStatusById(id, status, error) {
      writeCount += 1;
      calls.push(["message", id, status, error]);
      return { id, contact_id: 20, delivery_status: status, delivery_error: error };
    },
  };
  const contacts = {
    async setDeliveryAttention(id, reason) {
      calls.push(["attention", id, reason]);
    },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    messages,
    contacts,
    async sendMessage() {
      return { success: true, wamid: "wamid.not-persisted" };
    },
  });

  assert.equal(writeCount, 1);
  assert.equal(calls[0][2], "unknown");
  assert.equal(calls[1][0], "attention");
  assert.equal(calls[2][0], "failed");
});


test("retry is cancelled when global automated replies are disabled", async () => {
  const calls = [];
  const repository = {
    async recoverStaleProcessing() { return []; },
    async claimDue() { return [baseRow()]; },
    async markCancelled(id, lease, reason) {
      calls.push(["cancelled", id, lease, reason]);
    },
    async findNextDueAt() { return null; },
  };
  const contacts = {
    async setDeliveryAttention(id, reason) {
      calls.push(["attention", id, reason]);
    },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    messages: {},
    contacts,
    isAutomationEnabled() { return false; },
    async sendMessage() {
      throw new Error("Meta must not be called when automation is disabled");
    },
  });

  assert.equal(calls[0][0], "cancelled");
  assert.match(calls[0][3], /automated replies are disabled/i);
  assert.equal(calls[1][0], "attention");
});

test("concurrent accepted WAMID wins over an ambiguity update", async () => {
  const calls = [];
  const repository = {
    async recoverStaleProcessing() { return []; },
    async claimDue() { return [baseRow()]; },
    async markSent(id, lease) {
      calls.push(["sent", id, lease]);
    },
    async markFailed() {
      throw new Error("accepted delivery must not be marked failed");
    },
    async findNextDueAt() { return null; },
  };
  const messages = {
    async markDeliveryUnknownIfUnconfirmed() {
      return {
        marked: false,
        accepted: true,
        message: {
          id: 10,
          contact_id: 20,
          whatsapp_message_id: "wamid.concurrent",
          delivery_status: "pending",
        },
      };
    },
  };
  const contacts = {
    async clearDeliveryAttentionIfNoFailedMessages(id) {
      calls.push(["clear", id]);
    },
    async setDeliveryAttention() {
      throw new Error("accepted delivery must not raise attention");
    },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    messages,
    contacts,
    evidence: {
      async recordOutcome(input) {
        calls.push(["evidence", input.providerMessageId]);
      },
    },
    async sendMessage() {
      return {
        success: false,
        wamid: null,
        ambiguous: true,
        retryable: false,
        error: "network timeout",
      };
    },
  });

  assert.deepEqual(calls, [
    ["sent", 1, "lease-1"],
    ["evidence", "wamid.concurrent"],
    ["clear", 20],
  ]);
});
