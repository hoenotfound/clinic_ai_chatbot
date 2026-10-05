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
    async sendMessage() {
      return { success: true, wamid: "wamid.retry-success" };
    },
  });

  assert.deepEqual(calls[0], ["wamid", 10, "wamid.retry-success"]);
  assert.deepEqual(calls[1], ["sent", 1, "lease-1"]);
  assert.deepEqual(calls[2], ["clear", 20]);
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
  assert.equal(calls[1][0], "failed");
  assert.equal(calls[2][0], "attention");
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
