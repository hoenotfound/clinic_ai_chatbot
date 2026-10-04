const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DEFAULT_SYNC_INTERVAL_MS,
  createMetaAdsInsightsSyncService,
  syncIntervalMs,
} = require("../src/services/metaAdsInsightsSyncService");

function silentLogger() {
  return { log() {}, warn() {}, error() {} };
}

function baseRepo(overrides = {}) {
  return {
    async tryAcquireSyncLease() {
      return true;
    },
    async renewSyncLease() {
      return true;
    },
    async releaseSyncLease() {
      return true;
    },
    async resetBackfillCoverage() {},
    async getSyncState() {
      return null;
    },
    async markSyncStarted() {},
    async markBackfillProgress() {},
    async replaceInsightsRange() {},
    async markSyncSuccess() {},
    async markSyncFailure() {},
    ...overrides,
  };
}

function makeService({ repo, api, accountIds = ["123"] }) {
  return createMetaAdsInsightsSyncService({
    insightsRepo: repo,
    insightsApi: api,
    tokenGetter: () => "token",
    accountIdsGetter: () => accountIds,
    leaseTokenFactory: () => "lease-token",
    now: () => new Date("2026-10-04T00:00:00+08:00"),
    logger: silentLogger(),
  });
}

test("Insights sync defaults to hourly while preserving explicit overrides", () => {
  assert.equal(DEFAULT_SYNC_INTERVAL_MS, 60 * 60 * 1000);
  assert.equal(syncIntervalMs({}), 60 * 60 * 1000);
  assert.equal(
    syncIntervalMs({ META_AD_INSIGHTS_SYNC_MS: String(30 * 60 * 1000) }),
    30 * 60 * 1000
  );
});

test("first successful sync backfills 90 days in resumable 30-day chunks", async () => {
  const calls = [];
  const repo = baseRepo({
    async tryAcquireSyncLease(accountId, token) {
      calls.push(["lease", accountId, token]);
      return true;
    },
    async renewSyncLease(accountId, token) {
      calls.push(["renew", accountId, token]);
      return true;
    },
    async markSyncStarted(accountId, since, until, token) {
      calls.push(["started", accountId, since, until, token]);
    },
    async replaceInsightsRange(accountId, since, until, rows) {
      calls.push(["replace", accountId, since, until, rows.length]);
    },
    async markBackfillProgress(accountId, since, until, nextDate, token) {
      calls.push(["progress", accountId, since, until, nextDate, token]);
    },
    async markSyncSuccess(accountId, since, until, token, options) {
      calls.push(["success", accountId, since, until, token, options]);
    },
  });
  const api = {
    async fetchAdInsights(accountId, range) {
      calls.push(["fetch", accountId, range.since, range.until]);
      return [{
        accountId,
        accountCurrency: "MYR",
        date: range.until,
        adId: "300",
      }];
    },
  };

  const result = await makeService({ repo, api }).runOnce();

  assert.equal(result.status, "completed");
  assert.equal(result.rows, 3);
  assert.deepEqual(
    calls.filter((call) => call[0] === "fetch"),
    [
      ["fetch", "123", "2026-07-07", "2026-08-05"],
      ["fetch", "123", "2026-08-06", "2026-09-04"],
      ["fetch", "123", "2026-09-05", "2026-10-04"],
    ]
  );
  assert.deepEqual(
    calls.filter((call) => call[0] === "progress").map((call) => call[4]),
    ["2026-08-06", "2026-09-05"]
  );
  assert.deepEqual(calls.find((call) => call[0] === "success"), [
    "success",
    "123",
    "2026-07-07",
    "2026-10-04",
    "lease-token",
    { backfillCompleted: true },
  ]);
});

test("a partial backfill resumes from the persisted next date", async () => {
  const fetched = [];
  const repo = baseRepo({
    async getSyncState() {
      return {
        last_backfill_completed_at: null,
        backfill_next_date: "2026-09-05",
        coverage_start_date: "2026-07-07",
        coverage_end_date: "2026-09-04",
      };
    },
  });
  const api = {
    async fetchAdInsights(accountId, range) {
      fetched.push(range);
      return [{
        accountId,
        accountCurrency: "MYR",
        date: range.until,
        adId: "300",
      }];
    },
  };

  const result = await makeService({ repo, api }).runOnce();

  assert.equal(result.accounts[0].backfill, true);
  assert.deepEqual(fetched, [
    { since: "2026-09-05", until: "2026-10-04" },
  ]);
});

test("completed accounts only refresh the recent three-day window", async () => {
  let range = null;
  const repo = baseRepo({
    async getSyncState() {
      return {
        last_backfill_completed_at: "2026-09-01T00:00:00Z",
        coverage_start_date: "2026-07-07",
        coverage_end_date: "2026-10-04",
      };
    },
  });
  const api = {
    async fetchAdInsights(accountId, nextRange) {
      range = nextRange;
      return [];
    },
  };

  const result = await makeService({ repo, api }).runOnce();

  assert.deepEqual(range, { since: "2026-10-02", until: "2026-10-04" });
  assert.equal(result.accounts[0].backfill, false);
});

test("an older completed sync without coverage metadata performs one repair backfill", async () => {
  const fetched = [];
  let resetCoverage = null;
  const repo = baseRepo({
    async getSyncState() {
      return {
        last_backfill_completed_at: "2026-09-01T00:00:00Z",
        coverage_start_date: null,
        coverage_end_date: null,
      };
    },
    async resetBackfillCoverage(accountId, since) {
      resetCoverage = [accountId, since];
    },
  });
  const api = {
    async fetchAdInsights(accountId, range) {
      fetched.push(range);
      return [{
        accountId,
        accountCurrency: "MYR",
        date: range.until,
        adId: "300",
      }];
    },
  };

  const result = await makeService({ repo, api }).runOnce();

  assert.equal(result.accounts[0].backfill, true);
  assert.deepEqual(resetCoverage, ["123", "2026-07-07"]);
  assert.deepEqual(fetched, [
    { since: "2026-07-07", until: "2026-08-05" },
    { since: "2026-08-06", until: "2026-09-04" },
    { since: "2026-09-05", until: "2026-10-04" },
  ]);
});

test("an account locked by another Render instance is skipped without calling Meta", async () => {
  let fetches = 0;
  const repo = baseRepo({
    async tryAcquireSyncLease() {
      return false;
    },
  });
  const api = {
    async fetchAdInsights() {
      fetches += 1;
      return [];
    },
  };

  const result = await makeService({ repo, api }).runOnce();

  assert.equal(fetches, 0);
  assert.deepEqual(result.accounts[0], {
    status: "locked",
    accountId: "123",
    rows: 0,
  });
});

test("credential failures are persisted and stop the same bad token hitting other accounts", async () => {
  const attempted = [];
  const failures = [];
  const repo = baseRepo({
    async tryAcquireSyncLease(accountId) {
      attempted.push(["lease", accountId]);
      return true;
    },
    async markSyncStarted(accountId) {
      attempted.push(["started", accountId]);
    },
    async markSyncFailure(accountId, since, until, message, token) {
      failures.push({ accountId, since, until, message, token });
      return true;
    },
  });
  const api = {
    async fetchAdInsights() {
      const err = new Error("Missing ads_read permission");
      err.code = 10;
      err.configurationError = true;
      throw err;
    },
  };

  const result = await makeService({
    repo,
    api,
    accountIds: ["123", "456"],
  }).runOnce();

  assert.equal(result.status, "completed");
  assert.deepEqual(
    attempted.filter((entry) => entry[0] === "lease").map((entry) => entry[1]),
    ["123"]
  );
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /Missing ads_read permission/);
  assert.equal(failures[0].token, "lease-token");
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
