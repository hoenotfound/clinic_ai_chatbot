const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pool } = require("../src/db/db");
const { recordDecision } = require("../src/db/resultMediaDecisionRepo");

test("result image decisions are stored once per inbound message for staff diagnostics", async (t) => {
  const original = pool.query;
  t.after(() => { pool.query = original; });
  const executed = [];
  pool.query = async (sql, params) => {
    executed.push({ sql, params });
    return { rowCount: 1 };
  };
  await recordDecision({
    contactId: 367,
    inboundMessageId: 1253,
    status: "partial",
    reason: "result_media_paced_after_promotions",
    promotionCount: 2,
    selectedCount: 1,
    sentCount: 1,
  });
  assert.equal(executed.length, 1);
  assert.match(executed[0].sql, /ON CONFLICT \(inbound_message_id\) DO UPDATE/);
  assert.deepEqual(executed[0].params,
    [367, 1253, "partial", "result_media_paced_after_promotions", 2, 1, 1]);
  await assert.rejects(
    recordDecision({ contactId: 367, inboundMessageId: null, status: "skipped" }),
    /persisted message\/contact IDs/
  );
});

test("result audit schema is additive, per-message and private", () => {
  const migration = fs.readFileSync(
    path.join(__dirname, "../src/db/migrations/065_result_media_decisions.sql"),
    "utf8"
  );
  assert.match(migration, /CREATE TABLE IF NOT EXISTS result_media_decisions/);
  assert.match(migration, /inbound_message_id INTEGER NOT NULL UNIQUE REFERENCES messages\(id\) ON DELETE CASCADE/);
  assert.match(migration, /promotion_images_sent/);
  assert.match(migration, /result_images_sent/);
});
