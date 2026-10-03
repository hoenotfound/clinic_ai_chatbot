const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createMetaAdsInsightsSyncService,
} = require("../src/services/metaAdsInsightsSyncService");

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

test("first successful sync backfills 90 days and marks backfill complete", async () => {
  const calls = [];
  const repo = {
    async getSyncState(accountId) {
      calls.push(["state", accountId]);
      return null;
    },
    async markSyncStarted(accountId, since, until) {
      calls.push(["started", accountId, since, until]);
    },
    async replaceInsightsRange(accountId, since, until, rows) {
      calls.push(["replace", accountId, since, until, rows.length]);
    },
    async markSyncSuccess(accountId, since, until, options) {
      calls.push(["success", accountId, since, until, options]);
    },
    async markSyncFailure() {
      throw new Error("should not fail");
    },
  };
  const api = {
    async fetchAdInsights(accountId, range) {
      calls.push(["fetch", accountId, range.since, range.until]);
      return [{ accountId, date: range.until, adId: "300" }];
    },
  };

  const service = createMetaAdsInsightsSyncService({
    insightsRepo: repo,
    insightsApi: api,
    tokenGetter: () => "token",
    accountIdsGetter: () => ["123"],
    now: () => new Date("2026-10-04T00:00:00+08:00"),
    logger: silentLogger(),
  });

  const result = await service.runOnce();
  assert.equal(result.status, "completed");
  assert.equal(result.rows, 1);
  assert.deepEqual(calls.find((call) => call[0] === "fetch"), [
    "fetch",
    "123",
    "2026-07-07",
    "2026-10-04",
  ]);
  assert.deepEqual(calls.find((call) => call[0] === "success")[4], {
    backfillCompleted: true,
  });
});

test("completed accounts only refresh the recent three-day window", async () => {
  let range = null;
  const repo = {
    async getSyncState() {
      return { last_backfill_completed_at: "2026-09-01T00:00:00Z" };
    },
    async markSyncStarted() {},
    async replaceInsightsRange() {},
    async markSyncSuccess() {},
    async markSyncFailure() {},
  };
  const api = {
    async fetchAdInsights(accountId, nextRange) {
      range = nextRange;
      return [];
    },
  };

  const service = createMetaAdsInsightsSyncService({
    insightsRepo: repo,
    insightsApi: api,
    tokenGetter: () => "token",
    accountIdsGetter: () => ["123"],
    now: () => new Date("2026-10-04T00:00:00+08:00"),
    logger: silentLogger(),
  });

  await service.runOnce();
  assert.deepEqual(range, { since: "2026-10-02", until: "2026-10-04" });
});

test("credential failures are persisted and stop the same bad token hitting other accounts", async () => {
  const attempted = [];
  const failures = [];
  const repo = {
    async getSyncState() {
      return null;
    },
    async markSyncStarted(accountId) {
      attempted.push(accountId);
    },
    async replaceInsightsRange() {},
    async markSyncSuccess() {},
    async markSyncFailure(accountId, since, until, message) {
      failures.push({ accountId, message });
    },
  };
  const api = {
    async fetchAdInsights() {
      const err = new Error("Missing ads_read permission");
      err.code = 10;
      err.configurationError = true;
      throw err;
    },
  };

  const service = createMetaAdsInsightsSyncService({
    insightsRepo: repo,
    insightsApi: api,
    tokenGetter: () => "token",
    accountIdsGetter: () => ["123", "456"],
    now: () => new Date("2026-10-04T00:00:00+08:00"),
    logger: silentLogger(),
  });

  const result = await service.runOnce();
  assert.equal(result.status, "completed");
  assert.deepEqual(attempted, ["123"]);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Missing ads_read permission/);
});

test("worker remains idle unless both a Marketing API token and ad account are configured", async () => {
  const service = createMetaAdsInsightsSyncService({
    insightsRepo: {},
    insightsApi: {},
    tokenGetter: () => "",
    accountIdsGetter: () => [],
    logger: silentLogger(),
  });

  assert.equal(service.configured(), false);
  assert.deepEqual(await service.runOnce(), {
    status: "not_configured",
    accounts: [],
    rows: 0,
  });
});
