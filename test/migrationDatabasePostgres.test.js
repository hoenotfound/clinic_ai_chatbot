const test = require("node:test");
const assert = require("node:assert/strict");
const { Pool } = require("pg");
const { createMigrationLifecycle } = require("../src/utils/migrationLifecycle");
const { instrumentDatabase } = require("../src/db/migrationDatabase");

test("real PostgreSQL transaction finishes its receipt before migration pool closes", {
  skip: !process.env.TEST_DATABASE_URL, timeout: 10000,
}, async t => {
  const c = createMigrationLifecycle({ enabled: true });
  const pool = instrumentDatabase(new Pool({ connectionString: process.env.TEST_DATABASE_URL }), c);
  let release, entered;
  const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  t.after(async () => { release(); if (!pool.ending) await pool.end(); });
  const task = c.run("synthetic receipt transaction", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("CREATE TEMP TABLE migration_synthetic_receipt (id integer) ON COMMIT DROP");
      entered(); await gate;
      await new Promise((resolve, reject) => client.query("INSERT INTO migration_synthetic_receipt VALUES (1)",
        error => error ? reject(error) : resolve()));
      assert.equal((await client.query("SELECT count(*)::int AS n FROM migration_synthetic_receipt")).rows[0].n, 1);
      await client.query("COMMIT");
    } finally { client.release(); }
  });
  await Promise.race([started, task]);
  const drained = c.drain(); assert.equal(c.status().safeToRetire, false);
  release(); await task;
  assert.equal((await drained).safeToRetire, true); assert.equal(pool.ended, true);
  assert.throws(() => pool.query("SELECT 1"), /paused/);
  assert.equal(c.status().safeToRetire, false);
});
