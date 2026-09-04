const test = require("node:test");
const assert = require("node:assert/strict");

const {
  claimLiveItem,
  flagTerminalFailure,
  groupJobsByContact,
  processClaimedBatch,
  replyQueueKeyForRecoveredItems,
  runInboundProcessingRecovery,
} = require("../src/services/inboundProcessingService");
const { enqueueReplyConversation } = require("../src/utils/conversationQueue");

test("live inbound work claims its durable pending job before debounce", async () => {
  const repository = {
    async claimPendingByMessageId(messageId) {
      assert.equal(messageId, 777);
      return { id: 12, message_id: messageId, status: "processing", attempts: 1 };
    },
  };

  const claimed = await claimLiveItem(
    {
      savedInbound: { id: 777 },
      incoming: { id: "wamid-1" },
      contact: { id: 42 },
    },
    repository
  );

  assert.equal(claimed.processingJobId, 12);
});

test("successful batch processing marks every durable job completed", async () => {
  const completed = [];
  const repository = {
    async markCompleted(jobId) {
      completed.push(jobId);
      return { id: jobId, status: "completed" };
    },
    async markFailed() {
      throw new Error("should not fail a successful batch");
    },
  };
  const seen = [];
  const items = [
    { processingJobId: 1, incoming: { id: "a" } },
    { processingJobId: 2, incoming: { id: "b" } },
  ];

  await processClaimedBatch(
    items,
    async (batch) => seen.push(...batch.map((item) => item.incoming.id)),
    repository
  );

  assert.deepEqual(seen, ["a", "b"]);
  assert.deepEqual(completed.sort((a, b) => a - b), [1, 2]);
});

test("failed batch processing persists retryable failure state", async () => {
  const failed = [];
  const repository = {
    async markCompleted() {
      throw new Error("should not complete a failed batch");
    },
    async markFailed(jobId, err) {
      failed.push([jobId, err.message]);
      return { id: jobId, status: "failed", attempts: 1 };
    },
  };
  const items = [
    { processingJobId: 4 },
    { processingJobId: 5 },
  ];

  await assert.rejects(
    processClaimedBatch(
      items,
      async () => {
        throw new Error("simulated process interruption");
      },
      repository
    ),
    /simulated process interruption/
  );

  assert.deepEqual(failed, [
    [4, "simulated process interruption"],
    [5, "simulated process interruption"],
  ]);
});

test("recovered jobs are grouped by contact and replayed in message order", () => {
  const groups = groupJobsByContact([
    { id: 1, contact_id: 8, message_id: 30 },
    { id: 2, contact_id: 7, message_id: 20 },
    { id: 3, contact_id: 8, message_id: 10 },
  ]);

  assert.equal(groups.length, 2);
  const contact8 = groups.find((group) => group[0].contact_id === 8);
  assert.deepEqual(contact8.map((job) => job.message_id), [10, 30]);
});

test("recovery uses the same channel-specific reply queue keys as live traffic", () => {
  assert.equal(
    replyQueueKeyForRecoveredItems([
      { incoming: { channel: "whatsapp", from: "60135550000" }, contact: { id: 1 } },
    ]),
    "60135550000"
  );
  assert.equal(
    replyQueueKeyForRecoveredItems([
      { incoming: { channel: "instagram", from: "igsid-88" }, contact: { id: 2 } },
    ]),
    "instagram:igsid-88"
  );
  assert.equal(
    replyQueueKeyForRecoveredItems([
      { incoming: { channel: "facebook" }, contact: { id: 3 } },
    ]),
    "contact:3"
  );
});

test("restart recovery cannot run in parallel with a live reply for the same customer", async () => {
  const order = [];
  let releaseLive;
  const liveGate = new Promise((resolve) => {
    releaseLive = resolve;
  });

  const live = enqueueReplyConversation("60136660000", async () => {
    order.push("live-start");
    await liveGate;
    order.push("live-finish");
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["live-start"]);

  const job = {
    id: 71,
    contact_id: 12,
    message_id: 501,
    status: "processing",
    attempts: 2,
  };
  const repository = {
    async claimRecoverable() {
      return [job];
    },
    async markCompleted(jobId) {
      assert.equal(jobId, 71);
      order.push("recovery-complete");
      return { ...job, status: "completed" };
    },
    async markFailed() {
      throw new Error("recovery should not fail");
    },
    async listExhausted() {
      return [];
    },
    async pruneCompleted() {
      return 0;
    },
  };

  const recovery = runInboundProcessingRecovery({
    repository,
    contacts: { async setAttention() {} },
    async resumeJob() {
      return {
        processingJobId: 71,
        incoming: {
          id: "wamid-recovered",
          channel: "whatsapp",
          from: "60136660000",
          text: "recovered message",
        },
        contact: { id: 12, channel: "whatsapp", mode: "ai" },
        savedInbound: { id: 501, contact_id: 12, content: "recovered message" },
      };
    },
    async processBatch() {
      order.push("recovery-start");
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(order, ["live-start"]);

  releaseLive();
  await Promise.all([live, recovery]);
  assert.deepEqual(order, [
    "live-start",
    "live-finish",
    "recovery-start",
    "recovery-complete",
  ]);
});

test("a job that crashed on its final attempt is handed to staff instead of disappearing", async () => {
  const calls = [];
  const exhausted = {
    id: 99,
    contact_id: 42,
    message_id: 777,
    status: "processing",
    attempts: 5,
  };
  const repository = {
    async claimRecoverable(options) {
      assert.equal(options.maxAttempts, 5);
      return [];
    },
    async listExhausted(options) {
      assert.equal(options.maxAttempts, 5);
      return [exhausted];
    },
    async markTerminal(jobId) {
      calls.push(["terminal", jobId]);
      return { ...exhausted, status: "failed", terminal_at: new Date() };
    },
    async pruneCompleted() {
      return 0;
    },
  };
  const contacts = {
    async setAttention(contactId, needsAttention, reason) {
      calls.push(["attention", contactId, needsAttention, reason]);
    },
  };

  await runInboundProcessingRecovery({
    repository,
    contacts,
    async resumeJob() {
      throw new Error("no retryable jobs should be resumed");
    },
    async processBatch() {
      throw new Error("no retryable batch should be processed");
    },
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].slice(0, 3), ["attention", 42, true]);
  assert.match(calls[0][3], /Staff review is required/);
  assert.deepEqual(calls[1], ["terminal", 99]);
});

test("terminal bookkeeping waits until staff attention is safely persisted", async () => {
  let terminalMarked = false;
  const result = await flagTerminalFailure(
    { id: 100, contact_id: 44, attempts: 5 },
    {
      async setAttention() {
        throw new Error("temporary database failure");
      },
    },
    {
      async markTerminal() {
        terminalMarked = true;
      },
    }
  );

  assert.equal(result, false);
  assert.equal(terminalMarked, false);
});
