"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { Pool } = require("pg");
const express = require("express");
const { createOpsReadinessRouter } = require("../src/routes/opsReadiness");
const { createPoolActivityTracker } = require("../src/services/databasePoolActivity");
const { normalizeRemoteSnapshot } = require("../src/ops/clientPoller");

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
  pool.emit("acquire");
  pool.emit("acquire");
  at += 6 * 60_000;
  pool.emit("acquire");
  pool.emit("remove");

  const first = tracker.snapshot();
  assert.equal(first.acquiredTotal, 3);
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
