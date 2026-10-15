"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const {
  databasePoolOptions,
  DEFAULT_DATABASE_CONNECT_TIMEOUT_MS,
  DEFAULT_DATABASE_POOL_MAX,
  DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_MS,
} = require("../src/db/db");

test("Neon pool preserves production defaults until a cold-start change is approved", () => {
  const defaults = databasePoolOptions({
    DATABASE_URL: "postgresql://user:password@db.example.com/chatbot",
    CLIENT_SLUG: "neutro-sense-tcm",
  });
  assert.equal(defaults.connectionTimeoutMillis, DEFAULT_DATABASE_CONNECT_TIMEOUT_MS);
  assert.equal(defaults.connectionTimeoutMillis, 10_000);
  assert.equal(defaults.max, DEFAULT_DATABASE_POOL_MAX);
  assert.equal(defaults.max, 10);
  assert.equal(defaults.idleTimeoutMillis, DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_MS);
  assert.equal(defaults.idleTimeoutMillis, 10_000);
  assert.equal(defaults.application_name, "da-chatbot-neutro-sense-tcm");
});

test("pool overrides are bounded and cannot accidentally pin all idle connections", () => {
  const options = databasePoolOptions({
    DATABASE_URL: "postgresql://example",
    CLIENT_SLUG: "test/unsafe name",
    DATABASE_CONNECT_TIMEOUT_MS: "20000",
    DATABASE_POOL_MAX: "5",
    DATABASE_POOL_IDLE_TIMEOUT_MS: "15000",
  });
  assert.equal(options.connectionTimeoutMillis, 20000);
  assert.equal(options.max, 5);
  assert.equal(options.idleTimeoutMillis, 15000);
  assert.equal(options.application_name, "da-chatbot-test-unsafe-name");

  for (const bad of ["0", "-1", "not-a-number", "9999999", "1.5"]) {
    assert.equal(databasePoolOptions({ DATABASE_POOL_MAX: bad }).max, DEFAULT_DATABASE_POOL_MAX);
    assert.equal(databasePoolOptions({ DATABASE_POOL_IDLE_TIMEOUT_MS: bad }).idleTimeoutMillis,
      DEFAULT_DATABASE_POOL_IDLE_TIMEOUT_MS);
    assert.equal(databasePoolOptions({ DATABASE_CONNECT_TIMEOUT_MS: bad }).connectionTimeoutMillis,
      DEFAULT_DATABASE_CONNECT_TIMEOUT_MS);
  }
});

test("Postgres pooled client reconnects after an idle socket is dropped", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  // Simulate a sleeping compute closing an existing idle TCP connection. This
  // is a test-only pool, never the application's production connection.
  const pool = new Pool({
    ...databasePoolOptions({
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      CLIENT_SLUG: "phase2-test",
    }),
    ssl: false,
    max: 1,
    idleTimeoutMillis: 30_000,
  });
  const idleErrors = [];
  pool.on("error", (error) => idleErrors.push(error));

  try {
    const client = await pool.connect();
    try {
      assert.equal(Number((await client.query("SELECT 7 AS result")).rows[0].result), 7);
    } finally {
      client.release();
    }

    const removed = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Idle client was not removed")), 5000);
      pool.once("remove", () => { clearTimeout(timeout); resolve(); });
    });
    client.connection.stream.destroy();
    await removed;

    const reconnect = await pool.query("SELECT 42 AS result");
    assert.equal(Number(reconnect.rows[0].result), 42);
    assert.equal(pool.waitingCount, 0);
    // The pool establishes a fresh connection; no failed user SQL is replayed.
    assert.ok(idleErrors.length <= 1);
  } finally {
    await pool.end();
  }
});
