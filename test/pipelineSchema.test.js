const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const schema = fs.readFileSync(
  path.join(__dirname, "..", "src", "db", "schema.sql"),
  "utf8"
);

test("schema protects legacy manual temperatures during migration", () => {
  assert.match(schema, /WHERE temperature IN \('hot', 'cold'\)/);
  assert.match(schema, /temperature_source = 'system'/);
  assert.match(schema, /temperature_locked = false/);
  assert.match(schema, /SET temperature_source = 'manual', temperature_locked = true/);
});

test("schema stores and backfills a transcript boundary for every lead journey", () => {
  assert.match(schema, /started_message_id INTEGER/);
  assert.match(schema, /WHERE l\.started_message_id IS NULL/);
  assert.match(schema, /WHEN l\.created_by = 'Migration' THEN/);
  assert.match(schema, /WHEN l\.created_by = 'Automation' THEN/);
  assert.match(schema, /m\.created_at >= l\.created_at/);
  assert.match(schema, /NOT IN \('Automation', 'Migration'\)/);
});
