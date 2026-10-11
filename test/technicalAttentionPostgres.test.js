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
const alerts = require("../src/services/telegramImmediateAlertService");
const push = require("../src/services/webPushNotificationService");
const { followUpAttentionAllowedSql } = require("../src/utils/aiReviewPolicy");

test("technical message reviews do not block follow-ups or promotional pictures, unlike clinical reviews", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const schema = `tech_review_${process.pid}_${Date.now()}`;
  const oldQuery = pool.query;
  const oldAlert = alerts.sendAiReviewAlert;
  const oldPush = push.sendContactAlertBestEffort;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE contacts (
        id integer primary key, mode text default 'ai',
        needs_attention boolean default false, attention_reason text,
        updated_at timestamptz default now()
      );
      CREATE TABLE messages (
        id integer primary key, contact_id integer references contacts(id),
        role text, content text
      );
    `);
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/064_ai_review_items.sql"), "utf8"));
    await client.query(`
      INSERT INTO contacts(id) VALUES (7);
      INSERT INTO messages(id,contact_id,role,content) VALUES
        (51,7,'user','[Voice message could not be transcribed]'),
        (52,7,'user','[Unsupported WhatsApp message]'),
        (53,7,'user','How much is the package?'),
        (54,7,'user','I am pregnant. Is 9D safe?');
    `);
    pool.query = (...args) => client.query(...args);
    let notifications = 0;
    alerts.sendAiReviewAlert = async () => { notifications += 1; return { status: "sent" }; };
    push.sendContactAlertBestEffort = () => {};

    await contacts.setAiReviewAttention(7,51,"Empty voice note","information");
    await contacts.setAiReviewAttention(7,52,"Meta unsupported code 131051","information");
    await contacts.setAiReviewAttention(7,51,"Duplicate webhook","information");
    const review = await client.query(`
      SELECT inbound_message_id, summary, category FROM ai_review_items ORDER BY inbound_message_id
    `);
    assert.deepEqual(review.rows.map(x=>x.inbound_message_id),[51,52]);
    assert.equal(review.rows[0].summary,"Empty voice note");
    assert.equal(notifications,2, "each inbound problem alerts once");
    const c = (await client.query("SELECT * FROM contacts WHERE id=7")).rows[0];
    assert.equal(c.mode,"ai");
    assert.match(c.attention_reason, /#51/);
    assert.match(c.attention_reason, /#52/);
    let allowed = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=7`);
    assert.equal(allowed.rows[0].allowed,true);
    assert.equal(await contacts.canSendAutomaticReviewMedia(7),true);

    await contacts.setAiReviewAttention(7,54,"Pregnancy suitability","clinical");
    allowed = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=7`);
    assert.equal(allowed.rows[0].allowed,false);
    assert.equal(await contacts.canSendAutomaticReviewMedia(7),false);
    assert.equal(notifications,3);
  } finally {
    pool.query = oldQuery;
    alerts.sendAiReviewAlert = oldAlert;
    push.sendContactAlertBestEffort = oldPush;
    try {
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    } finally {
      await client.end();
    }
  }
});
