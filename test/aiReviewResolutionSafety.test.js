const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
const { pool } = require("../src/db/db");
const contacts = require("../src/db/contactsRepo");
const { categorizeAiReview } = require("../src/utils/aiReviewPolicy");

test("medical-history questions are never treated as informational reviews", () => {
  for (const message of [
    "How much is 9D if I have diabetes?",
    "Price for 3D, I have cancer",
    "Can I book treatment with high blood pressure? What's the cost?",
    "9D price for PCOS condition?",
    "Harga 3D kalau saya ada kencing manis?",
    "Harga 9D, saya ada darah tinggi",
    "3D價格，患有糖尿病可以嗎？",
    "9D多少钱，有高血壓",
  ]) {
    assert.equal(categorizeAiReview(message, "information"), "clinical", message);
  }
  assert.equal(categorizeAiReview("What is the price?", "information"), "information");
});

test("resolving the last individual review preserves a failed delivery", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const schema = `ai_resolution_${process.pid}_${Date.now()}`;
  const oldQuery = pool.query;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE contacts (
        id integer primary key,
        mode text not null default 'ai',
        needs_attention boolean not null default false,
        attention_reason text,
        delivery_attention_dismissed_at timestamptz,
        delivery_attention_message_id integer,
        updated_at timestamptz default now()
      );
      CREATE TABLE scheduled_messages(message_id integer);
      CREATE TABLE messages (
        id integer primary key,
        contact_id integer references contacts(id),
        role text not null,
        created_at timestamptz default now(),
        delivery_status text,
        is_automated_follow_up boolean default false,
        whatsapp_message_id text,
        whatsapp_template jsonb, pricing_reminder_anchor_id integer,
        automated_follow_up_for_message_id integer,
        automated_follow_up_parent_message_id integer,
        media_key text,media_url text,media_base64 text,media_mime_type text
      );
    `);
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/064_ai_review_items.sql"), "utf8"));
    await client.query(`
      INSERT INTO contacts(id, needs_attention, attention_reason)
      VALUES (1, true, 'AI review requested: [#10] Please check');
      INSERT INTO messages(id,contact_id,role,delivery_status)
      VALUES (10,1,'user',NULL),(11,1,'assistant','failed');
      INSERT INTO ai_review_items(contact_id,inbound_message_id,category,summary)
      VALUES(1,10,'clinical','Please check');
    `);
    pool.query = (...args) => client.query(...args);
    const id = (await client.query("SELECT id FROM ai_review_items")).rows[0].id;
    const preserved = await contacts.resolveAiReviewItem(1, id);
    assert.equal(preserved.needs_attention, true);
    assert.match(preserved.attention_reason, /Delivery failed/);
    const status = await client.query("SELECT status FROM ai_review_items WHERE id=$1", [id]);
    assert.equal(status.rows[0].status, "resolved");
    await client.query("UPDATE messages SET delivery_status='sent' WHERE id=11");
    const dismissed = await contacts.dismissAttentionAndReviews(1);
    assert.equal(dismissed.needs_attention, false);
    assert.equal(dismissed.attention_reason, null);
  } finally {
    pool.query = oldQuery;
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
