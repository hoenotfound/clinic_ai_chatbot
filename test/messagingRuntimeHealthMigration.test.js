const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const migrationPath = path.join(
  __dirname,
  "..",
  "src",
  "db",
  "migrations",
  "013_messaging_runtime_health.sql"
);

test("social outbound health uses a tiny channel-only migration", () => {
  const sql = fs.readFileSync(migrationPath, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS messaging_runtime_health/);
  assert.match(sql, /channel TEXT PRIMARY KEY/);
  assert.match(sql, /last_outbound_accepted_at TIMESTAMPTZ/);
  assert.doesNotMatch(sql, /contact_id|recipient|message_id|message_content|access_token|api_key|password/i);
});
