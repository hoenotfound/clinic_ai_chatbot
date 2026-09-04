const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");

const loginRateLimitRepo = require("../src/db/loginRateLimitRepo");

const connectionString = process.env.TEST_DATABASE_URL;

async function makeClient(schemaName) {
  const client = new Client({ connectionString });
  await client.connect();
  await client.query(`SET search_path TO ${schemaName}`);
  return client;
}

test(
  "login rate limits persist, reserve atomically across connections and reset expired windows",
  { skip: !connectionString },
  async () => {
    const admin = new Client({ connectionString });
    const schemaName = `login_rate_limit_${process.pid}_${Date.now()}`;
    const schemaSql = fs.readFileSync(
      path.join(__dirname, "../src/db/loginRateLimitSchema.sql"),
      "utf8"
    );

    await admin.connect();
    try {
      await admin.query(`CREATE SCHEMA ${schemaName}`);
      await admin.query(`SET search_path TO ${schemaName}`);
      await admin.query(schemaSql);

      const keys = [
        { scope: "ip", keyHash: "a".repeat(64) },
        { scope: "username", keyHash: "b".repeat(64) },
        { scope: "pair", keyHash: "c".repeat(64) },
      ];

      await loginRateLimitRepo.recordFailure(keys, { windowSeconds: 900 }, admin);
      await loginRateLimitRepo.recordFailure(keys, { windowSeconds: 900 }, admin);
      await loginRateLimitRepo.recordFailure(keys, { windowSeconds: 900 }, admin);

      let states = await loginRateLimitRepo.getStates(keys, admin);
      assert.deepEqual(
        Object.fromEntries(states.map((row) => [row.scope, Number(row.failures)])),
        { ip: 3, username: 3, pair: 3 }
      );

      // A second database connection simulates a fresh Render process. The
      // counters must still exist because they are no longer process memory.
      const restarted = await makeClient(schemaName);
      try {
        states = await loginRateLimitRepo.getStates(keys, restarted);
        assert.deepEqual(
          Object.fromEntries(states.map((row) => [row.scope, Number(row.failures)])),
          { ip: 3, username: 3, pair: 3 }
        );

        await loginRateLimitRepo.clearKeys(
          keys.filter((key) => key.scope !== "ip"),
          restarted
        );
        states = await loginRateLimitRepo.getStates(keys, restarted);
        assert.deepEqual(states.map((row) => row.scope), ["ip"]);
        assert.equal(Number(states[0].failures), 3);

        // Undoing a successful request's pre-reservation subtracts only that
        // request; previous IP-wide failures remain intact.
        await loginRateLimitRepo.decrementKeys([keys[0]], restarted);
        states = await loginRateLimitRepo.getStates([keys[0]], restarted);
        assert.equal(Number(states[0].failures), 2);
      } finally {
        await restarted.end();
      }

      // Multiple Render instances/processes reserving the same attempt bucket
      // at once must not lose increments. ON CONFLICT performs the increment
      // atomically on the row even across independent PostgreSQL connections.
      const concurrentKey = { scope: "pair", keyHash: "d".repeat(64) };
      const clients = await Promise.all(
        Array.from({ length: 6 }, () => makeClient(schemaName))
      );
      try {
        await Promise.all(
          clients.map((client) =>
            loginRateLimitRepo.recordFailure(
              [concurrentKey],
              { windowSeconds: 900 },
              client
            )
          )
        );
      } finally {
        await Promise.all(clients.map((client) => client.end()));
      }
      states = await loginRateLimitRepo.getStates([concurrentKey], admin);
      assert.equal(Number(states[0].failures), 6);

      // Expired fixed windows reset atomically to a fresh failure count of one.
      await admin.query(
        `UPDATE login_rate_limits
         SET failures = 40,
             window_started_at = NOW() - interval '20 minutes',
             updated_at = NOW() - interval '20 minutes'
         WHERE scope = 'ip'`
      );
      const reset = await loginRateLimitRepo.recordFailure(
        [keys[0]],
        { windowSeconds: 900 },
        admin
      );
      assert.equal(Number(reset[0].failures), 1);

      // Stale rows are bounded so a spray of one-off identifiers cannot grow
      // this security table forever.
      await admin.query(
        `UPDATE login_rate_limits
         SET updated_at = NOW() - interval '2 days'`
      );
      const pruned = await loginRateLimitRepo.pruneExpired(
        { olderThanSeconds: 86400 },
        admin
      );
      assert.equal(pruned, 2);
    } finally {
      await admin.query("SET search_path TO public").catch(() => {});
      await admin.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => {});
      await admin.end();
    }
  }
);
