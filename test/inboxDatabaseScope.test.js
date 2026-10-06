const test = require("node:test");
const assert = require("node:assert/strict");
const { createScopedPool, withInboxDatabaseTimeouts } = require("../src/db/inboxDatabaseScope");

function fakePool() {
  const connections = [];
  const calls = [];
  const database = {
    async query(...args) { calls.push(args); return { rows: [{ ordinary: true }] }; },
    async connect() {
      const client = { settings: ["0", "0"], released: false,
        async query(sql, params) {
          calls.push([sql, params]);
          if (sql.includes("current_setting")) return { rows: [{ statement: client.settings[0], lock: client.settings[1] }] };
          if (sql.includes("set_config")) { client.settings = params; return { rows: [] }; }
          if (sql === "FAIL") throw new Error("SQL failed");
          return { rows: [{ settings: [...client.settings] }] };
        },
        release(error) { client.released = true; client.releaseError = error; },
      };
      connections.push(client);
      return client;
    },
  };
  return { pool: createScopedPool(database), calls, connections };
}

test("Inbox SQL settings are scoped, reused and restored before pool reuse", async () => {
  const fake = fakePool();
  assert.equal((await fake.pool.query("OUTSIDE")).rows[0].ordinary, true);
  await withInboxDatabaseTimeouts(async () => {
    const first = await fake.pool.query("ONE");
    const second = await fake.pool.query("TWO");
    assert.deepEqual(first.rows[0].settings, ["10000ms", "5000ms"]);
    assert.deepEqual(second.rows[0].settings, ["10000ms", "5000ms"]);
  });
  assert.equal(fake.connections.length, 1);
  assert.deepEqual(fake.connections[0].settings, ["0", "0"]);
  assert.equal(fake.connections[0].released, true);
  assert.equal((await fake.pool.query("OUTSIDE_AGAIN")).rows[0].ordinary, true);
});

test("Inbox query failure restores settings and does not poison the next request", async () => {
  const fake = fakePool();
  await assert.rejects(withInboxDatabaseTimeouts(() => fake.pool.query("FAIL")), /SQL failed/);
  assert.equal(fake.connections[0].released, true);
  assert.deepEqual(fake.connections[0].settings, ["0", "0"]);
  await withInboxDatabaseTimeouts(() => fake.pool.query("NEXT"));
  assert.equal(fake.connections.length, 2);
});

test("dedicated transaction connections keep Inbox limits and release safely", async () => {
  const fake = fakePool();
  await withInboxDatabaseTimeouts(async () => {
    const client = await fake.pool.connect();
    assert.deepEqual((await client.query("BEGIN")).rows[0].settings, ["10000ms", "5000ms"]);
    await client.query("ROLLBACK");
    await client.release();
  });
  assert.deepEqual(fake.connections[0].settings, ["0", "0"]);
  assert.equal(fake.connections[0].released, true);
});

test("concurrent background SQL does not inherit another request's Inbox limits", async () => {
  const fake = fakePool();
  let ready, release;
  const acquired = new Promise(resolve => { ready = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const inbox = withInboxDatabaseTimeouts(async () => { await fake.pool.query("INBOX"); ready(); await gate; });
  await acquired;
  assert.equal((await fake.pool.query("BACKGROUND")).rows[0].ordinary, true);
  release();
  await inbox;
});

test("real Postgres cancels Inbox lock waits and restores the connection", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const { Pool } = require("pg");
  const database = new Pool({ connectionString: process.env.TEST_DATABASE_URL, ssl: false, max: 3 });
  const scoped = createScopedPool(database);
  const blocker = await database.connect();
  try {
    await blocker.query("SELECT pg_advisory_lock(182736, 91)");
    await assert.rejects(withInboxDatabaseTimeouts(() => scoped.query("SELECT pg_advisory_lock(182736, 91)"), {},
      { lockTimeoutMs: 30, statementTimeoutMs: 100 }), error => error.code === "55P03" || error.code === "57014");
    const settings = await database.query("SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock");
    assert.deepEqual(settings.rows[0], { statement: "0", lock: "0" });
    await assert.rejects(withInboxDatabaseTimeouts(() => scoped.query("SELECT pg_sleep(1)"), {},
      { lockTimeoutMs: 30, statementTimeoutMs: 30 }), error => error.code === "57014");
  } finally {
    await blocker.query("SELECT pg_advisory_unlock(182736, 91)");
    blocker.release();
    await database.end();
  }
});
