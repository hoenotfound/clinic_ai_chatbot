const test = require("node:test");
const assert = require("node:assert/strict");

const {
  claimLiveItem,
  flagTerminalFailure,
  groupJobsByContact,
  processClaimedBatch,
  reconcileRecoveredOutbound,
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


test("recovery completes a provider-accepted outbound attempt instead of sending again", async () => {
  const calls = [];
  const job = { id: 201, contact_id: 42, attempts: 2 };
  const repository = {
    async getOutboundAttempt(jobId) {
      assert.equal(jobId, 201);
      return {
        outcome: "accepted",
        provider_message_id: "wamid.accepted",
        delivery_status: "pending",
      };
    },
    async markCompleted(jobId) {
      calls.push(["completed", jobId]);
      return { ...job, status: "completed" };
    },
  };
  const contacts = {
    async setAttention() {
      throw new Error("accepted recovery must not raise ambiguous attention");
    },
  };

  const handled = await reconcileRecoveredOutbound(job, { repository, contacts });

  assert.equal(handled, true);
  assert.deepEqual(calls, [["completed", 201]]);
});

test("recovery hands an ambiguous reserved outbound attempt to staff instead of resending", async () => {
  const calls = [];
  const job = { id: 202, contact_id: 43, attempts: 2 };
  const repository = {
    async getOutboundAttempt() {
      return {
        outcome: null,
        provider_message_id: null,
        whatsapp_message_id: null,
        delivery_status: null,
      };
    },
    async markTerminal(jobId) {
      calls.push(["terminal", jobId]);
      return { ...job, status: "failed", terminal_at: new Date() };
    },
  };
  const contacts = {
    async setAttention(contactId, enabled, reason) {
      calls.push(["attention", contactId, enabled, reason]);
    },
  };

  const handled = await reconcileRecoveredOutbound(job, { repository, contacts });

  assert.equal(handled, true);
  assert.deepEqual(calls[0].slice(0, 3), ["attention", 43, true]);
  assert.match(calls[0][3], /may already have reached the customer/i);
  assert.deepEqual(calls[1], ["terminal", 202]);
});

test("recovery restores delivery attention for a rejected outbound attempt without retrying it", async () => {
  const calls = [];
  const job = { id: 203, contact_id: 44, attempts: 2 };
  const repository = {
    async getOutboundAttempt() {
      return {
        outcome: "rejected",
        error_text: "Meta rejected the send",
        delivery_status: "failed",
      };
    },
    async markCompleted(jobId) {
      calls.push(["completed", jobId]);
    },
  };
  const contacts = {
    async setDeliveryAttention(contactId, reason) {
      calls.push(["delivery", contactId, reason]);
    },
  };

  const handled = await reconcileRecoveredOutbound(job, { repository, contacts });

  assert.equal(handled, true);
  assert.deepEqual(calls[0], ["delivery", 44, "Delivery failed: Meta rejected the send"]);
  assert.deepEqual(calls[1], ["completed", 203]);
});


test("recovery does not replay earlier burst messages when the final burst reply was already accepted", async () => {
  const completed = [];
  const resumed = [];
  const jobs = [
    {
      id: 301,
      contact_id: 55,
      message_id: 1001,
      status: "processing",
      attempts: 2,
    },
    {
      id: 302,
      contact_id: 55,
      message_id: 1002,
      status: "processing",
      attempts: 2,
    },
  ];

  const repository = {
    async claimRecoverable() {
      return jobs;
    },
    async getOutboundAttempt(jobId) {
      if (jobId === 302) {
        return {
          outcome: "accepted",
          provider_message_id: "wamid-final-burst",
          delivery_status: "pending",
        };
      }
      return null;
    },
    async markCompleted(jobId) {
      completed.push(jobId);
      return { id: jobId, status: "completed" };
    },
    async markFailed() {
      throw new Error("burst-covered jobs should not fail");
    },
    async listExhausted() {
      return [];
    },
    async pruneCompleted() {
      return 0;
    },
  };

  await runInboundProcessingRecovery({
    repository,
    contacts: { async setAttention() {} },
    async resumeJob(job) {
      resumed.push(job.id);
      throw new Error("burst-covered jobs must not be resumed");
    },
    async processBatch() {
      throw new Error("burst-covered jobs must not create a new AI reply");
    },
  });

  assert.deepEqual(resumed, []);
  assert.deepEqual(completed.sort((a, b) => a - b), [301, 302]);
});


test("rejected recovery stays retryable until delivery attention is persisted", async () => {
  const job = {
    id: 204,
    contact_id: 45,
    message_id: 904,
    status: "processing",
    attempts: 2,
  };
  let sweep = 0;
  let attentionAttempts = 0;
  let failedCalls = 0;
  let completedCalls = 0;
  let resumedCalls = 0;

  const repository = {
    async claimRecoverable() {
      sweep += 1;
      return [{ ...job, attempts: sweep + 1 }];
    },
    async getOutboundAttempt(jobId) {
      assert.equal(jobId, job.id);
      return {
        outcome: "rejected",
        error_text: "Meta rejected the send",
        delivery_status: "failed",
      };
    },
    async markFailed(jobId, err) {
      assert.equal(jobId, job.id);
      assert.equal(err.code, "DELIVERY_ATTENTION_RESTORE_FAILED");
      failedCalls += 1;
      return { ...job, status: "failed", attempts: 3 };
    },
    async markCompleted(jobId) {
      assert.equal(jobId, job.id);
      completedCalls += 1;
      return { ...job, status: "completed" };
    },
    async listExhausted() {
      return [];
    },
    async pruneCompleted() {
      return 0;
    },
  };

  const contacts = {
    async setDeliveryAttention(contactId, reason) {
      assert.equal(contactId, job.contact_id);
      assert.match(reason, /Meta rejected the send/);
      attentionAttempts += 1;
      if (attentionAttempts === 1) {
        throw new Error("temporary database failure");
      }
    },
    async setAttention() {
      throw new Error("this retry has not exhausted automatic attempts");
    },
  };

  const recoveryOptions = {
    repository,
    contacts,
    async resumeJob() {
      resumedCalls += 1;
      throw new Error("a rejected outbound attempt must never be resent");
    },
    async processBatch() {
      throw new Error("a rejected outbound attempt must never reach AI again");
    },
  };

  await runInboundProcessingRecovery(recoveryOptions);
  assert.equal(attentionAttempts, 1);
  assert.equal(failedCalls, 1);
  assert.equal(completedCalls, 0);
  assert.equal(resumedCalls, 0);

  await runInboundProcessingRecovery(recoveryOptions);
  assert.equal(attentionAttempts, 2);
  assert.equal(failedCalls, 1);
  assert.equal(completedCalls, 1);
  assert.equal(resumedCalls, 0);
});


test("accepted final burst reply still covers earlier messages when completion bookkeeping fails", async () => {
  const oldJob = {
    id: 401,
    contact_id: 61,
    message_id: 1401,
    status: "processing",
    attempts: 2,
  };
  const finalJob = {
    id: 402,
    contact_id: 61,
    message_id: 1402,
    status: "processing",
    attempts: 2,
  };
  const completed = [];
  const failed = [];
  const resumed = [];

  const repository = {
    async claimRecoverable() {
      return [oldJob, finalJob];
    },
    async getOutboundAttempt(jobId) {
      if (jobId !== finalJob.id) return null;
      return {
        outcome: "accepted",
        provider_message_id: "wamid-final-accepted",
        delivery_status: "pending",
      };
    },
    async markCompleted(jobId) {
      if (jobId === finalJob.id) {
        throw new Error("temporary completion bookkeeping failure");
      }
      completed.push(jobId);
      return { id: jobId, status: "completed" };
    },
    async markFailed(jobId, err) {
      failed.push([jobId, err.message]);
      return { ...finalJob, id: jobId, status: "failed", attempts: 3 };
    },
    async listExhausted() {
      return [];
    },
    async pruneCompleted() {
      return 0;
    },
  };

  await runInboundProcessingRecovery({
    repository,
    contacts: {
      async setAttention() {
        throw new Error("accepted attempt should not require staff attention");
      },
    },
    async resumeJob(job) {
      resumed.push(job.id);
      throw new Error("burst-covered message must not be resumed");
    },
    async processBatch() {
      throw new Error("burst-covered message must not reach AI");
    },
  });

  assert.deepEqual(completed, [oldJob.id]);
  assert.deepEqual(failed, [
    [finalJob.id, "temporary completion bookkeeping failure"],
  ]);
  assert.deepEqual(resumed, []);
});

test("rejected final burst reply still covers earlier messages when attention persistence fails", async () => {
  const oldJob = {
    id: 411,
    contact_id: 62,
    message_id: 1411,
    status: "processing",
    attempts: 2,
  };
  const finalJob = {
    id: 412,
    contact_id: 62,
    message_id: 1412,
    status: "processing",
    attempts: 2,
  };
  const completed = [];
  const failed = [];
  const resumed = [];
  let attentionAttempts = 0;

  const repository = {
    async claimRecoverable() {
      return [oldJob, finalJob];
    },
    async getOutboundAttempt(jobId) {
      if (jobId !== finalJob.id) return null;
      return {
        outcome: "rejected",
        error_text: "Meta rejected the send",
        delivery_status: "failed",
      };
    },
    async markCompleted(jobId) {
      completed.push(jobId);
      return { id: jobId, status: "completed" };
    },
    async markFailed(jobId, err) {
      failed.push([jobId, err.code]);
      return { ...finalJob, id: jobId, status: "failed", attempts: 3 };
    },
    async listExhausted() {
      return [];
    },
    async pruneCompleted() {
      return 0;
    },
  };

  await runInboundProcessingRecovery({
    repository,
    contacts: {
      async setDeliveryAttention(contactId, reason) {
        assert.equal(contactId, finalJob.contact_id);
        assert.match(reason, /Meta rejected the send/);
        attentionAttempts += 1;
        throw new Error("temporary attention write failure");
      },
      async setAttention() {
        throw new Error("job has not exhausted automatic recovery attempts");
      },
    },
    async resumeJob(job) {
      resumed.push(job.id);
      throw new Error("burst-covered message must not be resumed");
    },
    async processBatch() {
      throw new Error("burst-covered message must not reach AI");
    },
  });

  assert.equal(attentionAttempts, 1);
  assert.deepEqual(completed, [oldJob.id]);
  assert.deepEqual(failed, [
    [finalJob.id, "DELIVERY_ATTENTION_RESTORE_FAILED"],
  ]);
  assert.deepEqual(resumed, []);
});

test("ambiguous final burst reply still covers earlier messages when terminal bookkeeping fails", async () => {
  const oldJob = {
    id: 421,
    contact_id: 63,
    message_id: 1421,
    status: "processing",
    attempts: 2,
  };
  const finalJob = {
    id: 422,
    contact_id: 63,
    message_id: 1422,
    status: "processing",
    attempts: 2,
  };
  const completed = [];
  const failed = [];
  const resumed = [];
  const attention = [];
  let terminalAttempts = 0;

  const repository = {
    async claimRecoverable() {
      return [oldJob, finalJob];
    },
    async getOutboundAttempt(jobId) {
      if (jobId !== finalJob.id) return null;
      return {
        outcome: "ambiguous",
        provider_message_id: null,
        whatsapp_message_id: null,
        delivery_status: "unknown",
        delivery_error: "Delivery could not be confirmed.",
      };
    },
    async markCompleted(jobId) {
      completed.push(jobId);
      return { id: jobId, status: "completed" };
    },
    async markTerminal(jobId) {
      assert.equal(jobId, finalJob.id);
      terminalAttempts += 1;
      throw new Error("temporary terminal bookkeeping failure");
    },
    async markFailed(jobId, err) {
      failed.push([jobId, err.message]);
      return { ...finalJob, id: jobId, status: "failed", attempts: 3 };
    },
    async listExhausted() {
      return [];
    },
    async pruneCompleted() {
      return 0;
    },
  };

  await runInboundProcessingRecovery({
    repository,
    contacts: {
      async setAttention(contactId, enabled, reason) {
        attention.push([contactId, enabled, reason]);
      },
    },
    async resumeJob(job) {
      resumed.push(job.id);
      throw new Error("burst-covered message must not be resumed");
    },
    async processBatch() {
      throw new Error("burst-covered message must not reach AI");
    },
  });

  assert.equal(terminalAttempts, 1);
  assert.equal(attention.length, 1);
  assert.deepEqual(attention[0].slice(0, 2), [finalJob.contact_id, true]);
  assert.match(attention[0][2], /may already have reached the customer/i);
  assert.deepEqual(completed, [oldJob.id]);
  assert.deepEqual(failed, [
    [finalJob.id, "temporary terminal bookkeeping failure"],
  ]);
  assert.deepEqual(resumed, []);
});


test("outbound-attempt lookup failure defers the whole recovered contact before any AI replay", async () => {
  const oldJob = {
    id: 431,
    contact_id: 64,
    message_id: 1431,
    status: "processing",
    attempts: 2,
  };
  const finalJob = {
    id: 432,
    contact_id: 64,
    message_id: 1432,
    status: "processing",
    attempts: 2,
  };
  let sweep = 0;
  let finalLookupAttempts = 0;
  const failed = [];
  const completed = [];
  const resumed = [];

  const repository = {
    async claimRecoverable() {
      sweep += 1;
      return [
        { ...oldJob, attempts: sweep + 1 },
        { ...finalJob, attempts: sweep + 1 },
      ];
    },
    async getOutboundAttempt(jobId) {
      if (jobId === finalJob.id) {
        finalLookupAttempts += 1;
        if (finalLookupAttempts === 1) {
          throw new Error("temporary outbound-attempt lookup failure");
        }
        return {
          outcome: "accepted",
          provider_message_id: "wamid-final-after-retry",
          delivery_status: "pending",
        };
      }
      return null;
    },
    async markFailed(jobId, err) {
      failed.push([sweep, jobId, err.message]);
      return {
        ...(jobId === finalJob.id ? finalJob : oldJob),
        status: "failed",
        attempts: sweep + 1,
      };
    },
    async markCompleted(jobId) {
      completed.push([sweep, jobId]);
      return { id: jobId, status: "completed" };
    },
    async listExhausted() {
      return [];
    },
    async pruneCompleted() {
      return 0;
    },
  };

  const recoveryOptions = {
    repository,
    contacts: {
      async setAttention() {
        throw new Error("lookup retry has not exhausted automatic attempts");
      },
    },
    async resumeJob(job) {
      resumed.push([sweep, job.id]);
      throw new Error("outbound lookup uncertainty must block AI replay");
    },
    async processBatch() {
      throw new Error("outbound lookup uncertainty must block AI processing");
    },
  };

  await runInboundProcessingRecovery(recoveryOptions);

  assert.equal(finalLookupAttempts, 1);
  assert.deepEqual(
    failed.map((entry) => entry.slice(1, 3)),
    [
      [oldJob.id, "temporary outbound-attempt lookup failure"],
      [finalJob.id, "temporary outbound-attempt lookup failure"],
    ]
  );
  assert.deepEqual(completed, []);
  assert.deepEqual(resumed, []);

  await runInboundProcessingRecovery(recoveryOptions);

  assert.equal(finalLookupAttempts, 2);
  assert.deepEqual(completed, [
    [2, finalJob.id],
    [2, oldJob.id],
  ]);
  assert.deepEqual(resumed, []);
});
