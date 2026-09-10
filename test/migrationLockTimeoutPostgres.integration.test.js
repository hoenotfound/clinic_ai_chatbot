const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");

const { acquireMigrationLock } = require("../src/db/migrationRunner");

const connectionString = process.env.TEST_DATABASE_URL;

function uniqueLockKeys() {
  const second = (Date.now() % 1_000_000_000) + (process.pid % 100_000);
  return [441122, second];
}

test(
  "migration lock contention fails within the configured deadline instead of blocking startup",
  { skip: !connectionString },
  async () => {
    const holder = new Client({ connectionString });
    const contender = new Client({ connectionString });
    const lockKeys = uniqueLockKeys();
    await Promise.all([holder.connect(), contender.connect()]);

    try {
      await holder.query("SELECT pg_advisory_lock($1, $2)", lockKeys);
      const startedAt = Date.now();

      await assert.rejects(
        () => acquireMigrationLock(contender, {
          lockKeys,
          timeoutMs: 150,
          retryMs: 20,
        }),
        (err) => {
          assert.equal(err.code, "MIGRATION_LOCK_TIMEOUT");
          assert.match(err.message, /timed out after 150ms/i);
          return true;
        }
      );

      const elapsedMs = Date.now() - startedAt;
      assert.ok(
        elapsedMs < 2_000,
        `Expected bounded lock wait, but it took ${elapsedMs}ms.`
      );
    } finally {
      await holder
        .query("SELECT pg_advisory_unlock($1, $2)", lockKeys)
        .catch(() => {});
      await Promise.allSettled([holder.end(), contender.end()]);
    }
  }
);
