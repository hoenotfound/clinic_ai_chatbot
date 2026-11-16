const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyCounts, inspect } = require("../scripts/neutroMigrationBoundary.cjs");

test("pending work stays pending; in-flight and ambiguous states require review", () => {
  const groups = ["pending", "completed", "reserved", "claimed", "unknown", "ambiguous", null].map(value => ({ value, count: 1 }));
  assert.deepEqual(classifyCounts(groups).map(g => g.value), ["reserved", "claimed", "unknown", "ambiguous", null]);
});
test("quiet database never claims worker retirement or cutover readiness", async () => {
  const sql = [];
  const result = await inspect({ query: async statement => { sql.push(statement); return { rows: [] }; } });
  assert.equal(result.cutoverAuthorized, false);
  assert.equal(result.processRetirementVerified, false);
  assert.match(sql[0], /REPEATABLE READ READ ONLY/);
  assert.equal(sql.at(-1), "ROLLBACK");
  assert.ok(sql.every(s => /^(BEGIN|SELECT|ROLLBACK)/.test(s)));
});
test("failed observation rolls back and cannot report a safe boundary", async () => {
  const sql = [];
  await assert.rejects(inspect({ query: async statement => {
    sql.push(statement); if (statement.startsWith("SELECT")) throw Error("unavailable"); return { rows: [] };
  } }));
  assert.equal(sql.at(-1), "ROLLBACK");
});
