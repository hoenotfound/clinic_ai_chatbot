"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Pool } = require("pg");
const express = require("express");
const { createOpsReadinessRouter } = require("../src/routes/opsReadiness");
const { createPoolActivityTracker } = require("../src/services/databasePoolActivity");
const { normalizeRemoteSnapshot } = require("../src/ops/clientPoller");
const { createAdaptiveWorkerTimer } = require("../src/utils/adaptiveWorkerTimer");
const {
  currentDatabaseActivitySource,
  withDatabaseActivitySource,
} = require("../src/utils/databaseActivityContext");
const { createRequireOpsReadinessToken } = require("../src/middleware/requireOpsReadinessToken");

test("pool observation is passive and keeps bounded minute windows", () => {
  const pool = new EventEmitter();
  pool.totalCount = 2;
  pool.idleCount = 1;
  pool.waitingCount = 0;
  let at = Date.UTC(2026, 9, 15, 7, 0);
  const before = pool.listenerCount("acquire");
  const tracker = createPoolActivityTracker(pool, { now: () => at });
  assert.equal(pool.listenerCount("acquire"), before + 1);

  pool.emit("connect");
  withDatabaseActivitySource("WhatsApp recovery", () => pool.emit("acquire"));
  pool.emit("acquire");
  at += 6 * 60_000;
  withDatabaseActivitySource("Meta comment recovery", () => pool.emit("acquire"));
  pool.emit("remove");

  const first = tracker.snapshot();
  assert.equal(first.acquiredTotal, 3);
  assert.equal(first.bySource.find(row => row.source === "WhatsApp recovery").acquiredTotal, 1);
  assert.equal(first.bySource.find(row => row.source === "Meta comment recovery").last5Minutes, 1);
  assert.equal(first.bySource.find(row => row.source === "unattributed").acquiredTotal, 1);
  assert.equal(first.connectedTotal, 1);
  assert.equal(first.removedTotal, 1);
  assert.equal(first.last5Minutes, 1);
  assert.equal(first.last15Minutes, 3);
  assert.equal(first.openConnections, 2);
  assert.equal(first.idleConnections, 1);
  assert.equal(first.waitingForConnection, 0);

  at += 16 * 60_000;
  const idle = tracker.snapshot();
  assert.equal(idle.last5Minutes, 0);
  assert.equal(idle.last15Minutes, 0);
  assert.equal(idle.acquiredTotal, 3);
  assert.ok(idle.lastAcquireAt.endsWith("07:06:00.000Z"));
});

test("registry accepts only known non-sensitive pool counters", () => {
  const result = normalizeRemoteSnapshot({
    source: "da-chatbot",
    schemaVersion: 1,
    client: { slug: "neutro-sense-tcm" },
    deployment: { commitSha: "abc" },
    readiness: { status: "ready" },
    databasePool: {
      acquiredTotal: 32,
      connectedTotal: 2,
      removedTotal: 1,
      last5Minutes: 4,
      last15Minutes: 12,
      openConnections: 1,
      idleConnections: 1,
      waitingForConnection: 0,
      lastAcquireAt: "2026-10-15T07:06:00.000Z",
      databaseUrl: "postgresql://private-token",
      customerPhone: "+60123456789",
    },
  }, "neutro-sense-tcm");
  assert.equal(result.databasePool.acquiredTotal, 32);
  assert.equal(result.databasePool.last5Minutes, 4);
  assert.equal(result.databasePool.databaseUrl, undefined);
  assert.equal(result.databasePool.customerPhone, undefined);
  assert.doesNotMatch(JSON.stringify(result), /private-token|60123456789/);
});

test("registry gracefully handles older client readiness without pool metrics", () => {
  const result = normalizeRemoteSnapshot({
    source: "da-chatbot",
    schemaVersion: 1,
    client: { slug: "older-client" },
    readiness: { status: "ready" },
  }, "older-client");
  assert.equal(result.databasePool, null);
});

test("PostgreSQL integration: query acquisition is visible without extra telemetry SQL", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const pool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL,
    ssl: false,
    max: 2,
    idleTimeoutMillis: 1000,
  });
  const tracker = createPoolActivityTracker(pool);
  try {
    assert.equal(tracker.snapshot().acquiredTotal, 0);
    const result = await pool.query("SELECT 1 AS ready");
    assert.equal(Number(result.rows[0].ready), 1);
    const metrics = tracker.snapshot();
    assert.ok(metrics.acquiredTotal >= 1);
    assert.ok(metrics.connectedTotal >= 1);
    assert.ok(metrics.openConnections >= 1);
    assert.ok(metrics.idleConnections >= 1);
    await withDatabaseActivitySource("Neon phase2 query test", async () => {
      await pool.query("SELECT 2 AS ready");
    });
    const labelled = tracker.snapshot().bySource.find(
      (row) => row.source === "Neon phase2 query test"
    );
    assert.ok(labelled?.acquiredTotal >= 1, "warm pooled query should retain worker label");
  } finally {
    await pool.end();
  }
});

test("pool-activity route is read-only and never runs the full database-backed readiness loader", async () => {
  let fullReadinessCalls = 0;
  let poolSnapshots = 0;
  const app = express();
  app.use("/api/ops/readiness", createOpsReadinessRouter({
    authenticate: (_req, _res, next) => next(),
    loadReadiness: async () => { fullReadinessCalls += 1; throw new Error("must not query DB"); },
    loadPoolActivity: () => { poolSnapshots += 1; return { acquiredTotal: 2, last5Minutes: 0 }; },
  }));
  const server = await new Promise(resolve => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ops/readiness/pool-activity`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.databasePool.acquiredTotal, 2);
    assert.equal(fullReadinessCalls, 0);
    assert.equal(poolSnapshots, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("adaptive recovery preserves its source across asynchronous DB acquisition", async () => {
  const fakePool = new EventEmitter();
  fakePool.totalCount = 1;
  fakePool.idleCount = 1;
  fakePool.waitingCount = 0;
  const tracker = createPoolActivityTracker(fakePool);
  const tasks = [];
  const worker = createAdaptiveWorkerTimer({
    label: "WhatsApp delivery-status recovery",
    run: async () => {
      await Promise.resolve();
      fakePool.emit("acquire");
      return null;
    },
    delayForResult: () => null,
    setTimeoutImpl: (fn) => {
      tasks.push(fn);
      return { unref() {} };
    },
    clearTimeoutImpl: () => {},
  });
  worker.start();
  assert.equal(currentDatabaseActivitySource(), "unattributed");
  await tasks.shift()();
  assert.equal(currentDatabaseActivitySource(), "unattributed");
  assert.equal(tracker.snapshot().bySource[0].source, "WhatsApp delivery-status recovery");
  worker.stop();
});

test("unauthorized pool observation is rejected before any database or pool access", async () => {
  const token = "x".repeat(32);
  const makeApp = (env) => {
    let poolCalls = 0;
    let readinessCalls = 0;
    const app = express();
    app.use("/api/ops/readiness", createOpsReadinessRouter({
      authenticate: createRequireOpsReadinessToken({ env }),
      loadReadiness: async () => { readinessCalls++; throw new Error("unwanted DB call"); },
      loadPoolActivity: () => { poolCalls++; return { acquiredTotal: 0 }; },
    }));
    return { app, calls: () => ({ poolCalls, readinessCalls }) };
  };
  const makeRequest = async (env, headers) => {
    const { app, calls } = makeApp(env);
    const server = await new Promise(resolve => {
      const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
    });
    try {
      const url = `http://127.0.0.1:${server.address().port}/api/ops/readiness/pool-activity`;
      const response = await fetch(url, { headers });
      const body = await response.json();
      return { status: response.status, body, headers: response.headers, calls: calls() };
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  };

  const disabled = await makeRequest({}, {});
  assert.equal(disabled.status, 404);
  assert.deepEqual(disabled.calls, { poolCalls: 0, readinessCalls: 0 });

  const unauthenticated = await makeRequest({ OPS_READINESS_TOKEN: token }, {});
  assert.equal(unauthenticated.status, 401);
  assert.deepEqual(unauthenticated.calls, { poolCalls: 0, readinessCalls: 0 });

  const invalid = await makeRequest(
    { OPS_READINESS_TOKEN: token },
    { authorization: `Bearer ${"y".repeat(32)}` }
  );
  assert.equal(invalid.status, 401);
  assert.deepEqual(invalid.calls, { poolCalls: 0, readinessCalls: 0 });

  const allowed = await makeRequest(
    { OPS_READINESS_TOKEN: token },
    { authorization: `Bearer ${token}` }
  );
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.deepEqual(allowed.calls, { poolCalls: 1, readinessCalls: 0 });
});

test("Ops Registry rejects secret or oversized per-worker source labels", () => {
  const base = {
    source: "da-chatbot", schemaVersion: 1,
    client: { slug: "neutro-sense-tcm" },
    readiness: { status: "ready" },
    databasePool: {
      bySource: [
        { source: "WhatsApp delivery-status recovery", acquiredTotal: 3, last5Minutes: 2, last15Minutes: 3 },
        { source: "customer +60123456789", acquiredTotal: 1, last5Minutes: 1, last15Minutes: 1 },
        { source: "private-token=" + "x".repeat(80), acquiredTotal: 3 },
      ],
    },
  };
  const value = normalizeRemoteSnapshot(base, "neutro-sense-tcm").databasePool.bySource;
  assert.equal(value.length, 1);
  assert.equal(value[0].source, "WhatsApp delivery-status recovery");
  assert.equal(value[0].last5Minutes, 2);
  assert.doesNotMatch(JSON.stringify(value), /60123456789|private-token/);
});
