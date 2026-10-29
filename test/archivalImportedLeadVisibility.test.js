const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { visibleSalesLeadSql } = require("../src/db/archivalImportedLeadVisibility");

const read = (name) => fs.readFileSync(path.join(__dirname, "../src/db", name), "utf8");

test("archival-only visibility is sender-neutral, reversible, and staff-safe", () => {
  const sql = visibleSalesLeadSql("l");
  assert.match(sql, /created_by = 'Migration'/);
  assert.match(sql, /archive_start\.message_id = l\.started_message_id/);
  assert.match(sql, /fresh_inbound\.role = 'user'/);
  assert.match(sql, /historic_inbound\.message_id = fresh_inbound\.id/);
  assert.match(sql, /staff_change\.changed_by <> 'Migration'/);
  assert.match(sql, /l\.owner_username IS NULL/);
  assert.doesNotMatch(sql, /DELETE FROM|UPDATE leads/i);
  assert.throws(() => visibleSalesLeadSql("l; DROP TABLE leads"), /Unsupported/);
});

test("all active reporting paths exclude historical-only leads, while Inbox records stay", () => {
  const pipeline = read("pipelineRepo.js");
  assert.match(pipeline, /WHERE \$\{visibleSalesLeadSql\("l"\)\} ORDER BY l\.updated_at/);
  assert.match(pipeline, /AND \$\{visibleSalesLeadSql\("l"\)\}\) AS lead_count/);
  assert.match(pipeline, /async function getLeadById\(id\)[\s\S]*?\$\{LEAD_SELECT\} WHERE l\.id = \$1/);
  const analytics = read("analyticsRepo.js");
  assert.match(analytics, /WHERE \$\{visibleSalesLeadSql\("l"\)\}/);
  const distribution = read("leadDistributionRepo.js");
  assert.match(distribution, /WHERE is_closed = false AND \$\{visibleSalesLeadSql\("l"\)\}/);
  const sales = read("salesFollowUpRepo.js");
  assert.match(sales, /archived\.message_id = last_inbound\.id/);
  const insights = read("contactInsightsRepo.js");
  assert.match(insights, /old_score\.message_id = score_choice\.through_message_id/);
});

test("Postgres hides historical backfills and reveals them on genuine customer reply or staff action", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `archive_lead_visibility_${process.pid}_${Date.now()}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE leads (
        id INTEGER PRIMARY KEY, contact_id INTEGER, created_by TEXT,
        owner_username TEXT, started_message_id INTEGER
      );
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY, contact_id INTEGER, role TEXT NOT NULL
      );
      CREATE TABLE lead_stage_history (
        lead_id INTEGER, changed_by TEXT
      );
      CREATE TABLE whatsapp_sender_coexistence_history_messages (
        message_id INTEGER PRIMARY KEY
      );
      INSERT INTO leads (id,contact_id,created_by,started_message_id)
      VALUES (10,1,'Migration',100),(20,2,'Automation',200),(30,3,'Migration',300);
      INSERT INTO messages(id,contact_id,role)
      VALUES (100,1,'user'),(200,2,'user'),(300,3,'user'),(301,3,'user');
      INSERT INTO whatsapp_sender_coexistence_history_messages(message_id)
      VALUES (100),(300),(301);
    `);
    const rows = async () => (await client.query(
      `SELECT l.id FROM leads l WHERE ${visibleSalesLeadSql("l")} ORDER BY l.id`
    )).rows.map(row => row.id);
    assert.deepEqual(await rows(), [20]);
    // A first fresh customer inquiry activates the same historical lead.
    await client.query("INSERT INTO messages(id,contact_id,role) VALUES (101,1,'user')");
    assert.deepEqual(await rows(), [10,20]);
    // Staff explicitly working a historical lead must never be hidden.
    await client.query("INSERT INTO lead_stage_history(lead_id,changed_by) VALUES (30,'staff-a')");
    assert.deepEqual(await rows(), [10,20,30]);
  } finally {
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
