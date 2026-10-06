const test = require("node:test");
const assert = require("node:assert/strict");

const {
  MAX_RETRY_ATTEMPTS,
  runWhatsappOutboundRetryQueue,
} = require("../src/services/whatsappOutboundRetryService");

const noOpInbound = {
  async finalizeOutboundAttemptByAssistantMessageId() {
    return null;
  },
};

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
    inbound: noOpInbound,
    messages,
    contacts,
    async sendDeliveryFailurePush() {
      throw new Error("transient retry must not push staff yet");
    },
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
    inbound: noOpInbound,
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
    inbound: noOpInbound,
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
  const pushes = [];
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
    inbound: noOpInbound,
    messages,
    contacts,
    async sendDeliveryFailurePush(input) {
      pushes.push(input);
    },
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
  assert.deepEqual(pushes, [{ contactId: 20 }]);
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
    inbound: noOpInbound,
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
    inbound: noOpInbound,
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
    inbound: noOpInbound,
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
    inbound: noOpInbound,
    messages: {},
    contacts,
    isAutomationEnabled() { return false; },
    async sendMessage() {
      throw new Error("Meta must not be called when automation is disabled");
    },
  });

  assert.equal(calls[0][0], "attention");
  assert.match(calls[0][2], /automated replies are disabled/i);
  assert.equal(calls[1][0], "cancelled");
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
    inbound: noOpInbound,
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


test("stale send-pending retry is safely rescheduled without calling Meta", async () => {
  const calls = [];
  const stale = baseRow({
    lease_token: "stale-pending-lease",
    processing_kind: "send_pending",
    last_error: "Meta busy",
  });
  const repository = {
    async recoverStaleProcessing() { return [stale]; },
    async claimDue() { return []; },
    async reschedule(id, lease, input) {
      calls.push(["reschedule", id, lease, input]);
    },
    async findNextDueAt() { return null; },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    inbound: noOpInbound,
    messages: {},
    contacts: {},
    async sendMessage() {
      throw new Error("send-pending recovery must not call Meta");
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ["reschedule", 1, "stale-pending-lease"]);
  assert.equal(calls[0][3].delaySeconds, 0);
});

test("final ownership check cancels a retry if staff takes over after claim", async () => {
  const calls = [];
  const repository = {
    async recoverStaleProcessing() { return []; },
    async claimDue() { return [baseRow()]; },
    async checkSendEligibility() {
      return baseRow({ contact_mode: "human" });
    },
    async prepareAttention(id, lease, reason) {
      calls.push(["prepare", id, lease, reason]);
      return { id };
    },
    async markCancelled(id, lease, reason) {
      calls.push(["cancelled", id, lease, reason]);
      return { id };
    },
    async findNextDueAt() { return null; },
  };
  const contacts = {
    async setDeliveryAttention(id, reason) {
      calls.push(["attention", id, reason]);
    },
  };

  let providerCalls = 0;
  await runWhatsappOutboundRetryQueue({
    repository,
    inbound: noOpInbound,
    messages: {},
    contacts,
    async sendMessage() {
      providerCalls += 1;
      return { success: true, wamid: "should-not-send" };
    },
  });

  assert.equal(providerCalls, 0);
  assert.equal(calls.some((entry) => entry[0] === "attention"), true);
  assert.equal(calls.some((entry) => entry[0] === "cancelled"), true);
});

test("production send path supplies service policy purpose before provider retry", async () => {
  const calls = [];
  const repository = {
    async recoverStaleProcessing() { return []; },
    async claimDue() { return [baseRow()]; },
    async checkSendEligibility() { return baseRow(); },
    async markSendStarted(id, lease) {
      calls.push(["started", id, lease]);
      return { id };
    },
    async prepareAttention(id, lease, reason) {
      calls.push(["prepare", id, lease, reason]);
      return { id };
    },
    async markFailed(id, lease, reason) {
      calls.push(["failed", id, lease, reason]);
      return { id };
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
    inbound: noOpInbound,
    messages: {
      async setDeliveryStatusById(id, status, error) {
        calls.push(["message", id, status, error]);
        return { id, contact_id: 20, delivery_status: status };
      },
    },
    contacts,
    async sendText(contact, text, options) {
      calls.push(["sendText", contact.id, text, options.purpose]);
      // Simulate the normal policy layer blocking a freeform message because
      // the 24-hour customer-service window has expired. It must block before
      // preSendCheck starts the provider-call fence.
      return {
        success: false,
        wamid: null,
        policyBlocked: true,
        policyCode: "outside_customer_service_window",
        retryable: false,
        ambiguous: false,
        error: "WhatsApp send blocked because the 24-hour customer-service window has closed.",
      };
    },
  });

  const send = calls.find((entry) => entry[0] === "sendText");
  assert.deepEqual(send.slice(1), [20, "Hello", "service"]);
  assert.equal(calls.some((entry) => entry[0] === "started"), false);
  assert.equal(calls.some((entry) => entry[0] === "attention"), true);
});

test("terminal retry defers durable staff attention instead of terminalizing when attention write fails", async () => {
  const calls = [];
  const repository = {
    async recoverStaleProcessing() { return []; },
    async claimDue() {
      return [baseRow({ attempts: MAX_RETRY_ATTEMPTS })];
    },
    async prepareAttention(id, lease, reason) {
      calls.push(["prepare", id, lease, reason]);
      return { id };
    },
    async deferAttention(id, lease, reason, options) {
      calls.push(["defer", id, lease, reason, options.delaySeconds]);
      return { id, status: "attention_pending" };
    },
    async markFailed() {
      throw new Error("must not terminalize before staff attention is durable");
    },
    async findNextDueAt() { return null; },
  };
  const contacts = {
    async setDeliveryAttention() {
      calls.push(["attention-attempt"]);
      throw new Error("temporary database failure");
    },
  };
  const messages = {
    async setDeliveryStatusById(id, status, error) {
      calls.push(["message", id, status, error]);
      return { id, contact_id: 20, delivery_status: status };
    },
  };

  await runWhatsappOutboundRetryQueue({
    repository,
    inbound: noOpInbound,
    messages,
    contacts,
    async sendMessage() {
      return {
        success: false,
        retryable: false,
        ambiguous: false,
        error: "permanent rejection",
      };
    },
  });

  assert.equal(calls.some((entry) => entry[0] === "prepare"), true);
  assert.equal(calls.some((entry) => entry[0] === "defer"), true);
  assert.equal(calls.some((entry) => entry[0] === "failed"), false);
});
