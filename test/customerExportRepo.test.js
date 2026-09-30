const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const customerExportRepo = require("../src/db/customerExportRepo");

test("assigned-only customer export scopes the query before returning rows", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let captured = null;
  pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };

  await customerExportRepo.listCustomerExportRows({
    search: "amy",
    assignment: "mine",
    currentUsername: "sales1",
    allowedContactIds: [7, 9],
    applyCurrentView: true,
  });

  assert.match(captured.sql, /c\.id = ANY\(\$1::int\[\]\)/);
  assert.match(captured.sql, /c\.name ILIKE \$2/);
  assert.match(captured.sql, /current_lead\.owner_username = \$3/);
  assert.match(captured.sql, /CASE WHEN c\.channel = 'whatsapp' THEN c\.whatsapp_number ELSE NULL END/);
  assert.deepEqual(captured.params, [[7, 9], "%amy%", "sales1"]);
});

test("an assigned-only user with no accessible contacts does not hit the export query", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let calls = 0;
  pool.query = async () => {
    calls += 1;
    return { rows: [] };
  };

  const rows = await customerExportRepo.listCustomerExportRows({
    allowedContactIds: [],
  });

  assert.deepEqual(rows, []);
  assert.equal(calls, 0);
});

test("all-customer export ignores current-view filters but keeps access scoping", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let captured = null;
  pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };

  await customerExportRepo.listCustomerExportRows({
    search: "ignored",
    assignment: "owner:other",
    allowedContactIds: [5],
    applyCurrentView: false,
  });

  assert.match(captured.sql, /c\.id = ANY\(\$1::int\[\]\)/);
  assert.doesNotMatch(captured.sql, /ILIKE/);
  assert.doesNotMatch(captured.sql, /current_lead\.owner_username = \$2/);
  assert.deepEqual(captured.params, [[5]]);
});
