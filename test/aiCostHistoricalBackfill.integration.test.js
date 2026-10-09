const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { estimateAiUsage } = require("../src/services/aiCostEstimator");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
function ident(value) { return '"' + String(value).replaceAll('"', '""') + '"'; }

test("migration 059 fills historical Gemini daily costs but never guesses lead attribution", {
  skip: !TEST_DATABASE_URL,
}, async (t) => {
  const db = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  await db.connect();
  const schema = "ai_cost_backfill_" + process.pid + "_" + Date.now();
  t.after(async () => {
    await db.query("SET search_path TO public").catch(() => {});
    await db.query("DROP SCHEMA IF EXISTS " + ident(schema) + " CASCADE").catch(() => {});
    await db.end();
  });
  await db.query("CREATE SCHEMA " + ident(schema));
  await db.query("SET search_path TO " + ident(schema));
  await db.query(`
    CREATE TABLE contacts (id INTEGER PRIMARY KEY);
    CREATE TABLE leads (id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id));
    CREATE TABLE ai_usage_events (
      id INTEGER PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      prompt_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      thinking_tokens BIGINT NOT NULL DEFAULT 0,
      cached_tokens BIGINT NOT NULL DEFAULT 0
    );
    INSERT INTO contacts VALUES (1);
    INSERT INTO leads VALUES (1,1);
    INSERT INTO ai_usage_events VALUES
      (1,'2026-10-06T12:00:00Z','gemini','gemini-3.8-flash',10000,200,100,4000),
      (2,'2026-10-06T12:00:00Z','gemini','unrecognized',10000,200,100,0),
      (3,'2026-10-06T12:00:00Z','gemini','gemini-3.8-flash',0,0,0,0),
      (4,'2026-10-06T12:00:00Z','claude','claude-sonnet-5',10000,200,0,0),
      (5,'2027-01-10T12:00:00Z','gemini','gemini-3.8-flash',10000,200,100,4000);
  `);
  const sql = fs.readFileSync(path.join(__dirname, "../src/db/migrations/059_ai_cost_attribution.sql"), "utf8");
  await db.query(sql);
  const rows = (await db.query("SELECT * FROM ai_usage_events ORDER BY id")).rows;
  const expected2026 = estimateAiUsage({
    provider: "gemini", model: "gemini-3.8-flash",
    promptTokens: 10000, outputTokens: 200, thinkingTokens: 100, cachedTokens: 4000,
  }, new Date("2026-10-06T12:00:00Z"));
  assert.equal(Number(rows[0].estimated_cost_usd), expected2026.costUsd);
  assert.equal(rows[0].pricing_status, "estimated");
  assert.equal(rows[0].contact_id, null);
  assert.equal(rows[0].lead_id, null);
  assert.equal(rows[1].pricing_status, "unpriced_model");
  assert.equal(rows[1].estimated_cost_usd, null);
  assert.equal(rows[2].pricing_status, "usage_unknown");
  assert.equal(rows[2].estimated_cost_usd, null);
  assert.equal(rows[3].pricing_status, "unpriced_model");
  assert.equal(rows[3].estimated_cost_usd, null);
  assert.equal(Number(rows[4].estimated_cost_usd), expected2026.costUsd * 2);
});
