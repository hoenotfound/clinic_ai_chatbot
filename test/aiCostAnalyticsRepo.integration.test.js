const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { getAiCostAnalytics } = require("../src/db/aiCostAnalyticsRepo");

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
function quoted(value) { return '"' + String(value).replaceAll('"', '""') + '"'; }

test("AI costs aggregate correctly in PostgreSQL and never leak unassigned contacts", {
  skip: !TEST_DATABASE_URL,
}, async (t) => {
  const db = new Client({ connectionString: TEST_DATABASE_URL, ssl: false });
  await db.connect();
  const schema = `ai_costs_it_${process.pid}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
  t.after(async () => {
    await db.query("SET search_path TO public").catch(() => {});
    await db.query(`DROP SCHEMA IF EXISTS ${quoted(schema)} CASCADE`).catch(() => {});
    await db.end();
  });
  await db.query(`CREATE SCHEMA ${quoted(schema)}`);
  await db.query(`SET search_path TO ${quoted(schema)}`);
  await db.query(`
    CREATE TABLE contacts (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL);
    CREATE TABLE ai_usage_events (
      id INTEGER PRIMARY KEY,
      contact_id INTEGER,
      created_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL,
      provider TEXT NOT NULL,
      purpose TEXT NOT NULL,
      model TEXT NOT NULL,
      estimated_cost_usd NUMERIC(16,10),
      prompt_tokens BIGINT NOT NULL DEFAULT 0,
      cached_tokens BIGINT NOT NULL DEFAULT 0,
      cache_metadata_present BOOLEAN,
      prompt_prefix_hash VARCHAR(16)
    );
  `);
  await db.query(`
    INSERT INTO contacts VALUES
      (1,'whatsapp',now()),
      (2,'instagram',now());
    INSERT INTO ai_usage_events VALUES
      (1,1,now(),'success','gemini','customer_reply','gemini-3.8-flash',0.0060,10000,0,false,'0123456789abcdef'),
      (2,1,now(),'failed','gemini','customer_reply','gemini-3.8-flash',NULL,0,0,NULL,NULL),
      (3,2,now(),'success','claude','customer_reply','claude-sonnet-5',0.0120,1200,0,NULL,NULL),
      (4,NULL,now(),'success','gemini','follow_up_generation','gemini-3.8-flash',0.0020,3500,0,false,'0123456789abcdef');
  `);
  const restricted = await getAiCostAnalytics({ database: db, accessibleContactIds: [1], fxRate: "4" });
  assert.equal(restricted.daily.at(-1).calls, 2);
  assert.equal(restricted.daily.at(-1).newLeads, 1);
  assert.equal(restricted.daily.at(-1).unpricedCalls, 1);
  assert.equal(restricted.daily.at(-1).estimatedUsd, 0.006);
  assert.deepEqual(restricted.byContact.map((x) => x.contactId), [1]);
  assert.equal(restricted.byCategory.length, 1);
  const all = await getAiCostAnalytics({ database: db, accessibleContactIds: null });
  assert.equal(all.daily.at(-1).calls, 4);
  assert.equal(all.daily.at(-1).unattributedCalls, 1);
  assert.equal(all.byContact.length, 2);
  assert.equal(all.daily.at(-1).newLeads, 2);
  const empty = await getAiCostAnalytics({ database: db, accessibleContactIds: [] });
  assert.equal(empty.daily.at(-1).calls, 0);
  assert.equal(empty.byContact.length, 0);
});
