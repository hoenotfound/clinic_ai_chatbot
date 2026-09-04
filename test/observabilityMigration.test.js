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
  "012_observability_health.sql"
);

function migrationSql() {
  return fs.readFileSync(migrationPath, "utf8");
}

test("observability is migration 012 and does not alter the immutable baseline", () => {
  assert.equal(path.basename(migrationPath), "012_observability_health.sql");
  const runner = fs.readFileSync(
    path.join(__dirname, "..", "src", "db", "migrationRunner.js"),
    "utf8"
  );
  assert.match(runner, /version:\s*11,\s*name:\s*"login_rate_limits"/);
  assert.doesNotMatch(runner, /version:\s*12,\s*name:/);
});

test("migration records inbound failures, stale lease recovery and AI routing without customer data", () => {
  const sql = migrationSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS inbound_failure_events/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS inbound_recovery_events/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS ai_routing_events/);
  assert.match(sql, /OLD\.lease_owner IS DISTINCT FROM NEW\.lease_owner/);
  assert.match(sql, /NEW\.attempts > OLD\.attempts/);
  assert.match(sql, /OLD\.status = 'processing'/);
  assert.match(sql, /NEW\.status = 'failed'/);
  assert.match(sql, /trg_inbound_processing_health_event/);
  assert.match(sql, /trg_inbound_meta_resolution_health_event/);
  assert.doesNotMatch(sql, /access_token|password|api_key|message_content|prompt_text|response_text/i);
});
