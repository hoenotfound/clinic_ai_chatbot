const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyCounts, inspect } = require("../scripts/neutroMigrationBoundary.cjs");
const emptySupplementary = { generation_claims: 0, pricing_retries: 0,
  manual_template_claims: 0, open_receipt_jobs: 0, terminal_receipt_jobs: 0 };

test("pending work stays pending; in-flight and ambiguous states require review", () => {
  const groups = ["pending", "completed", "reserved", "claimed", "unknown", "ambiguous", null].map(value => ({ value, count: 1 }));
  assert.deepEqual(classifyCounts(groups).map(g => g.value), ["reserved", "claimed", "unknown", "ambiguous", null]);
});
test("quiet database never claims worker retirement or cutover readiness", async () => {
  const sql = [];
  const result = await inspect({ query: async statement => {
    sql.push(statement);
    return { rows: statement.includes("AS generation_claims") ? [emptySupplementary] : [] };
  } });
  assert.equal(result.cutoverAuthorized, false);
  assert.equal(result.processRetirementVerified, false);
  assert.match(sql[0], /REPEATABLE READ READ ONLY/);
  assert.equal(sql.at(-1), "ROLLBACK");
  assert.ok(sql.every(s => /^(BEGIN|SELECT|ROLLBACK)/.test(s)));
});

test("receipt processing and state-less AI leases cannot disappear from the inspection", async () => {
  const statements = [];
  const result = await inspect({ query: async statement => {
    statements.push(statement);
    if (statement.includes("information_schema.columns")) {
      assert.match(statement, /'processing_status'/);
      return { rows: [{ table_name: 'whatsapp_delivery_status_jobs', column_name: 'processing_status' }] };
    }
    if (statement.includes('GROUP BY "processing_status"')) return { rows: [{ value: 'processing', count: 1 }] };
    if (statement.includes('AS generation_claims')) return { rows: [{ ...emptySupplementary, generation_claims: 2, open_receipt_jobs: 1, terminal_receipt_jobs: 5 }] };
    return { rows: [] };
  } });
  assert.deepEqual(result.requiresReview.map(g => [g.table, g.count]), [
    ['whatsapp_delivery_status_jobs', 1], ['follow_up_ai_generation_claims', 2],
  ]);
  assert.equal(result.supplementary.terminal_receipt_jobs, 5);
  assert.equal(result.cutoverAuthorized, false);
  assert.equal(statements.at(-1), 'ROLLBACK');
});

test("a missing supplementary queue result cannot produce a quiet success", async () => {
  const statements = [];
  await assert.rejects(inspect({ query: async statement => {
    statements.push(statement); return { rows: [] };
  } }), /Supplementary/);
  assert.equal(statements.at(-1), 'ROLLBACK');
});
test("failed observation rolls back and cannot report a safe boundary", async () => {
  const sql = [];
  await assert.rejects(inspect({ query: async statement => {
    sql.push(statement); if (statement.startsWith("SELECT")) throw Error("unavailable"); return { rows: [] };
  } }));
  assert.equal(sql.at(-1), "ROLLBACK");
});
