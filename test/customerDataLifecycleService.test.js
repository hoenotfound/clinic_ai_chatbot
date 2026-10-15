const test = require("node:test");
const assert = require("node:assert/strict");

const lifecycle = require("../src/services/customerDataLifecycleService");

test("customer retention is disabled by default and validates configured days", () => {
  assert.equal(lifecycle.retentionDaysFromEnv({}), 0);
  assert.equal(lifecycle.retentionDaysFromEnv({ CUSTOMER_DATA_RETENTION_DAYS: "0" }), 0);
  assert.equal(lifecycle.retentionDaysFromEnv({ CUSTOMER_DATA_RETENTION_DAYS: "90" }), 90);
  assert.throws(
    () => lifecycle.retentionDaysFromEnv({ CUSTOMER_DATA_RETENTION_DAYS: "7" }),
    /30 to 3650/
  );
  assert.throws(
    () => lifecycle.retentionDaysFromEnv({ CUSTOMER_DATA_RETENTION_DAYS: "abc" }),
    /30 to 3650/
  );
});

test("manual customer purge commits DB deletion and completes media cleanup immediately", async () => {
  const calls = [];
  const repository = {
    async purgeContactData(input) {
      calls.push(["purge", input]);
      return {
        status: "purged",
        job: { id: 9 },
        deletedCounts: { messages: 2 },
      };
    },
    async claimPurgeJob({ jobId, leaseToken }) {
      calls.push(["claim", jobId, leaseToken]);
      return {
        id: 9,
        contact_id: 42,
        attempts: 1,
        lease_token: leaseToken,
        media_keys: ["clients/acme/messages/42/a.jpg"],
        media_prefixes: ["clients/acme/messages/42/"],
      };
    },
    async markPurgeJobCompleted({ jobId, leaseToken }) {
      calls.push(["complete", jobId, leaseToken]);
      return { id: jobId, status: "completed" };
    },
    async markPurgeJobFailed() {
      throw new Error("unexpected failure path");
    },
  };
  const storage = {
    customerMediaPrefixes(contactId) {
      assert.equal(contactId, 42);
      return ["clients/acme/messages/42/"];
    },
    async deleteCustomerMediaObjects(input) {
      calls.push(["delete-media", input]);
      return 3;
    },
  };

  const events = [];
  const result = await lifecycle.purgeCustomerData({
    contactId: 42,
    requestedBy: "admin",
    reason: "manual",
  }, {
    repository,
    storage,
    events: {
      publish(type, payload) {
        events.push([type, payload]);
      },
    },
  });

  assert.equal(result.status, "purged");
  assert.equal(result.mediaCleanupPending, false);
  assert.equal(result.deletedMediaObjects, 3);
  assert.equal(calls[0][0], "purge");
  assert.equal(calls.some(([name]) => name === "complete"), true);
  assert.deepEqual(
    events.map(([type, payload]) => [type, payload.reason, payload.contactId]),
    [
      ["pipeline_changed", "customer_deleted", 42],
      ["conversation_changed", "customer_deleted", 42],
    ]
  );
});

test("R2 cleanup failure never rolls back an already committed customer purge", async () => {
  let failedRecorded = false;
  const repository = {
    async purgeContactData() {
      return { status: "purged", job: { id: 11 }, deletedCounts: {} };
    },
    async claimPurgeJob({ leaseToken }) {
      return {
        id: 11,
        contact_id: 77,
        attempts: 1,
        lease_token: leaseToken,
        media_keys: ["clients/acme/messages/77/a.jpg"],
        media_prefixes: [],
      };
    },
    async markPurgeJobCompleted() {
      throw new Error("should not complete");
    },
    async markPurgeJobFailed() {
      failedRecorded = true;
      return { id: 11, status: "failed" };
    },
  };
  const storage = {
    customerMediaPrefixes() {
      return [];
    },
    async deleteCustomerMediaObjects() {
      throw new Error("R2 unavailable");
    },
  };

  const result = await lifecycle.purgeCustomerData({
    contactId: 77,
    requestedBy: "admin",
  }, {
    repository,
    storage,
    events: { publish() {} },
  });

  assert.equal(result.status, "purged");
  assert.equal(result.mediaCleanupPending, true);
  assert.equal(failedRecorded, true);
});

test("disabled retention policy does not query customer candidates", async () => {
  let queried = false;
  const result = await lifecycle.runRetentionSweep({
    env: {},
    repository: {
      async listRetentionCandidates() {
        queried = true;
        return [];
      },
    },
    storage: {},
  });

  assert.equal(result.enabled, false);
  assert.equal(queried, false);
});


test("lifecycle recovery waits ten minutes on startup and uses adaptive retry deadlines", async () => {
  const intervals = [];
  let cleanupClaims = 0;
  let deadlineQueries = 0;
  let retentionQueries = 0;
  let pruneCalls = 0;
  let startupDelay = null;
  let workerOptions;

  const repository = {
    async claimPurgeJob() {
      cleanupClaims += 1;
      return null;
    },
    async getNextPurgeJobDueAt() {
      deadlineQueries += 1;
      return null;
    },
    async listRetentionCandidates() {
      retentionQueries += 1;
      return [];
    },
    async pruneCompletedPurgeJobs() {
      pruneCalls += 1;
      return {};
    },
  };

  lifecycle.startCustomerDataLifecycle({
    env: { CUSTOMER_DATA_RETENTION_DAYS: "90" },
    repository,
    storage: {},
    createWorkerTimer(options) {
      workerOptions = options;
      return {
        start(delay) { startupDelay = delay; },
        wake() { return true; },
      };
    },
    setIntervalFn(fn, delay) {
      const timer = { fn, delay, unref() {} };
      intervals.push(timer);
      return timer;
    },
  });

  assert.equal(cleanupClaims, 0);
  assert.equal(retentionQueries, 0);
  assert.equal(pruneCalls, 0);
  assert.equal(startupDelay, lifecycle.MEDIA_CLEANUP_INTERVAL_MS);
  assert.deepEqual(intervals.map((item) => item.delay), [
    lifecycle.RETENTION_SWEEP_INTERVAL_MS,
    lifecycle.PURGE_JOB_PRUNE_INTERVAL_MS,
  ]);

  assert.equal(await workerOptions.run(), null);
  assert.equal(cleanupClaims, 1);
  assert.equal(deadlineQueries, 1);
  assert.equal(workerOptions.delayForResult(null), lifecycle.IDLE_MEDIA_CLEANUP_INTERVAL_MS);

  await intervals[0].fn();
  assert.equal(retentionQueries, 1);
  await intervals[1].fn();
  assert.equal(pruneCalls, 1);
});

test("media cleanup wakes at the exact stored retry deadline", () => {
  const now = Date.parse("2026-10-15T10:00:00Z");
  assert.equal(
    lifecycle.mediaCleanupDelay("2026-10-15T10:00:30Z", now),
    30000
  );
  assert.equal(
    lifecycle.mediaCleanupDelay("2026-10-15T09:59:00Z", now),
    1000
  );
  assert.equal(
    lifecycle.mediaCleanupDelay(null, now),
    6 * 60 * 60 * 1000
  );
});
