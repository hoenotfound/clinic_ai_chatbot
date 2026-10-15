const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMetaCommentAutomationService,
  DEFAULT_COMMENT_AUTOMATION,
} = require("../src/services/metaCommentAutomationService");
const lifecycle = require("../src/services/customerDataLifecycleService");

function commentBody(id, text = "Price please") {
  return {
    object: "page",
    entry: [{
      id: "page-1",
      changes: [{
        field: "feed",
        value: {
          item: "comment", verb: "add", comment_id: id,
          post_id: "page-1_post-1", parent_id: "page-1_post-1",
          message: text, from: { id: "person-" + id, name: "Visitor" },
        },
      }],
    }],
  };
}

function capturedWorker() {
  let options;
  let stopped = true;
  const wakes = [];
  return {
    createRecoveryTimer(input) {
      options = input;
      return {
        start() { stopped = false; return () => { stopped = true; }; },
        stop() { stopped = true; },
        state() { return { stopped }; },
        wake(ms) { wakes.push(ms); return true; },
      };
    },
    get options() { return options; },
    wakes,
  };
}

test("comment webhook persistence does not run worker before staff echoes are finalized", async () => {
  const order = [];
  const timer = capturedWorker();
  const repo = {
    async storeIncomingComment(event) {
      order.push("persist");
      return { id: 13, ...event };
    },
    async claimJob(id) {
      order.push("claim:" + id);
      return null;
    },
    async listRecoverable() { return []; },
    async getNextRecoverableAt() { return null; },
  };
  const service = createMetaCommentAutomationService({
    repo, createRecoveryTimer: timer.createRecoveryTimer,
    config: { commentAutomation: { ...DEFAULT_COMMENT_AUTOMATION, enabled: true } },
    repliesEnabled: () => true,
  });
  service.startRecovery();
  const stored = await service.acceptIncomingComments(commentBody("comment-13"));
  assert.equal(stored.length, 1);
  assert.deepEqual(order, ["persist"]);
  assert.deepEqual(timer.wakes, [], "persistence must not wake recovery before staff echoes");
  order.push("staff-echo-finalized");
  await service.scheduleJob(stored[0].id);
  assert.deepEqual(order, ["persist", "staff-echo-finalized", "claim:13"]);
});

test("failed comment has a durable retry deadline and recovers without an early second attempt", async () => {
  const timer = capturedWorker();
  const failedJob = {
    id: 41, channel: "facebook", commentId: "comment-41",
    entryId: "page-1", authorId: "person-41",
    authorName: "Visitor", text: "I can't breathe",
    postId: "page-1_post-1", parentCommentId: null,
    rawEvent: {}, attemptCount: 1, sourceCreatedAt: new Date().toISOString(),
  };
  let failed = false;
  let eligible = false;
  let attempts = 0;
  let handoffs = 0;
  const dueAt = new Date(Date.now() + 15000);
  const repo = {
    async claimJob() { attempts++; return { ...failedJob, attemptCount: attempts }; },
    async markFailed(_id, _err) { failed = true; return { ...failedJob, status: "failed" }; },
    async markSkipped() { return { ...failedJob, status: "skipped" }; },
    async listRecoverable() { return eligible && failed ? [failedJob] : []; },
    async getNextRecoverableAt() { return failed && !eligible ? dueAt : null; },
  };
  const service = createMetaCommentAutomationService({
    repo, createRecoveryTimer: timer.createRecoveryTimer,
    config: {
      escalation: { handoffMessage: "Staff will follow up" },
      commentAutomation: { ...DEFAULT_COMMENT_AUTOMATION, enabled: true },
    },
    repliesEnabled: () => false,
    contacts: { getOrCreateChannelContact: async () => ({ id: 78, mode: "ai" }) },
    handoff: async () => {
      handoffs++;
      if (handoffs === 1) throw new Error("temporary handoff error");
      return { id: 78, mode: "human" };
    },
  });
  service.startRecovery();
  const first = await service.scheduleJob(failedJob.id);
  assert.equal(first.status, "failed");
  assert.equal(attempts, 1);
  assert.ok(timer.wakes.includes(0));
  const beforeRetry = await timer.options.run();
  assert.equal(attempts, 1, "retry must not run before the next_attempt_at deadline");
  assert.equal(beforeRetry.nextRecoverableAt, dueAt);
  assert.ok(timer.options.delayForResult(beforeRetry) > 0);
  eligible = true;
  const afterRetry = await timer.options.run();
  assert.equal(attempts, 2);
  assert.equal(handoffs, 2);
  assert.equal(afterRetry.nextRecoverableAt, null);
});

test("restart recovery serializes multiple durable jobs and atomic claims prevent duplicates", async () => {
  const timer = capturedWorker();
  const claimed = new Set();
  const calls = [];
  const jobs = [17, 18, 19].map(id => ({ id }));
  const repo = {
    async listRecoverable() { return jobs; },
    async claimJob(id) {
      calls.push(id);
      if (claimed.has(id)) return null;
      claimed.add(id);
      return null;
    },
    async getNextRecoverableAt() { return null; },
  };
  const service = createMetaCommentAutomationService({
    repo, createRecoveryTimer: timer.createRecoveryTimer,
  });
  // A new process recreates the worker and recovers rows left by its predecessor.
  service.startRecovery();
  await timer.options.run();
  await timer.options.run();
  assert.deepEqual([...claimed].sort((a, b) => a - b), [17, 18, 19]);
  assert.equal(calls.length, 6);
  assert.equal(timer.options.delayForResult({ nextRecoverableAt: null }), 15 * 60 * 1000);
});

test("failed R2 deletion is stored for retry, wakes cleanup and later completes", async () => {
  let pending = false;
  let leased = false;
  let failed = 0;
  let completed = 0;
  let deletionAttempts = 0;
  let cleanupOptions;
  const wakeDelays = [];
  const job = {
    id: 99, contact_id: 72, attempts: 1, lease_token: "cleanup-lease",
    media_keys: ["clients/test/72/a.jpg"], media_prefixes: ["clients/test/72/"],
  };
  const dueAt = new Date(Date.now() + 30000);
  const repo = {
    async purgeContactData() { return { status: "purged", job: { id: 99 }, deletedCounts: {} }; },
    async claimPurgeJob({ jobId } = {}) {
      if (jobId === 99) return { ...job };
      if (!pending || leased) return null;
      leased = true;
      return { ...job, attempts: 2 };
    },
    async markPurgeJobFailed() { failed++; pending = true; return { status: "failed" }; },
    async markPurgeJobCompleted() { completed++; pending = false; return { status: "completed" }; },
    async getNextPurgeJobDueAt() { return pending ? dueAt : null; },
  };
  const storage = {
    customerMediaPrefixes: () => ["clients/test/72/"],
    async deleteCustomerMediaObjects() {
      deletionAttempts++;
      if (deletionAttempts === 1) throw new Error("temporary R2 outage");
      return 1;
    },
  };
  lifecycle.startCustomerDataLifecycle({
    env: {},
    repository: repo,
    storage,
    createWorkerTimer(options) {
      cleanupOptions = options;
      return {
        start() {},
        wake(ms) { wakeDelays.push(ms); return true; },
      };
    },
    setIntervalFn: () => ({ unref() {} }),
  });
  const result = await lifecycle.purgeCustomerData({ contactId: 72 }, {
    repository: repo, storage,
    events: { publish() {} },
  });
  assert.equal(result.mediaCleanupPending, true);
  assert.equal(failed, 1);
  assert.ok(wakeDelays.includes(0));
  assert.equal(await cleanupOptions.run(), null, "retry attempt should complete when eligible");
  assert.equal(completed, 1);
  assert.equal(deletionAttempts, 2);
  assert.equal(pending, false);
  assert.equal(cleanupOptions.delayForResult(null), 30 * 60 * 1000);
});
