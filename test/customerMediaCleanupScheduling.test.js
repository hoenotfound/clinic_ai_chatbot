const test = require("node:test");
const assert = require("node:assert/strict");
const repo = require("../src/db/customerDataLifecycleRepo");

test("next customer media cleanup uses pending retries and stale processing deadlines", async () => {
  let statement;
  const dueAt = new Date("2026-10-15T10:02:00Z");
  const db = {
    async query(sql, values) {
      statement = { sql, values };
      return { rows: [{ due_at: dueAt }] };
    },
  };
  assert.equal(await repo.getNextPurgeJobDueAt(db), dueAt);
  assert.match(statement.sql, /next_attempt_at/);
  assert.match(statement.sql, /claimed_at/);
  assert.match(statement.sql, /MIN\(/);
  assert.deepEqual(statement.values, [repo.PURGE_PROCESSING_STALE_MINUTES]);
  assert.equal(
    await repo.getNextPurgeJobDueAt({
      query: async () => ({ rows: [{ due_at: null }] }),
    }),
    null
  );
});
