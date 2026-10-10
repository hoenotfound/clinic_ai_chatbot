const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
const { pool } = require("../src/db/db");
const contacts = require("../src/db/contactsRepo");
const telegram = require("../src/services/telegramImmediateAlertService");
const push = require("../src/services/webPushNotificationService");
const { followUpAttentionAllowedSql } = require("../src/utils/aiReviewPolicy");

test("Postgres preserves distinct pending questions and gates unsafe follow-ups", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({ connectionString: process.env.TEST_DATABASE_URL, ssl: false });
  const schema = `ai_review_${process.pid}_${Date.now()}`;
  const oldQuery = pool.query;
  const oldTelegram = telegram.sendHumanInterventionAlert;
  const oldPush = push.sendContactAlertBestEffort;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}`);
    await client.query(`
      CREATE TABLE contacts (id integer primary key, mode text default 'ai', takeover_by text, takeover_at timestamptz,
        needs_attention boolean default false, attention_reason text,
        updated_at timestamptz default now());
      CREATE TABLE messages (id integer primary key, contact_id integer references contacts(id),
        role text, content text);
    `);
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/064_ai_review_items.sql"), "utf8"));
    await client.query(`
      INSERT INTO contacts(id) VALUES (1);
      INSERT INTO messages(id, contact_id, role, content) VALUES
        (10,1,'user','Card payment?'),(11,1,'user','Recent HIFU?'),(12,1,'user','Parking?');
    `);
    let notified = 0;
    pool.query = (...args) => client.query(...args);
    telegram.sendHumanInterventionAlert = async () => { notified++; return {status:"queued"}; };
    push.sendContactAlertBestEffort = () => {};

    const first = await contacts.setAiReviewAttention(1,10,"Card payment?","information");
    assert.equal(first.mode,"ai");
    assert.equal(first.needs_attention,true);
    await contacts.setAiReviewAttention(1,10,"Duplicate retry","information");
    assert.equal(notified,1);
    let permission = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(permission.rows[0].allowed,true);

    const next = await contacts.setAiReviewAttention(1,11,"Recent HIFU?","clinical");
    assert.equal(next.mode,"ai");
    assert.ok(next.attention_reason.includes("#10"));
    assert.ok(next.attention_reason.includes("#11"));
    assert.equal(notified,2);
    permission = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(permission.rows[0].allowed,false);

    const pending = await client.query("SELECT inbound_message_id, category FROM ai_review_items WHERE status='pending' ORDER BY inbound_message_id");
    assert.deepEqual(pending.rows, [
      {inbound_message_id:10,category:"information"},
      {inbound_message_id:11,category:"clinical"},
    ]);
    // Staff takeover can clear the visible alert without resolving the
    // individual question records. Returning to AI must restore those reviews,
    // and a pending clinical question must still block unsolicited follow-ups.
    await client.query("UPDATE contacts SET mode='human', needs_attention=false, attention_reason=NULL WHERE id=1");
    let permissionAfterTakeover = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(permissionAfterTakeover.rows[0].allowed,false);
    const returnedToAi = await contacts.returnToAi(1);
    assert.equal(returnedToAi.mode,"ai");
    assert.equal(returnedToAi.needs_attention,true);
    assert.ok(returnedToAi.attention_reason.includes("#10"));
    assert.ok(returnedToAi.attention_reason.includes("#11"));
    permissionAfterTakeover = await client.query(`SELECT ${followUpAttentionAllowedSql("c")} AS allowed FROM contacts c WHERE id=1`);
    assert.equal(permissionAfterTakeover.rows[0].allowed,false);

    const resolvedContact = await contacts.dismissAttentionAndReviews(1);
    assert.equal(resolvedContact.needs_attention,false);
    const resolved = await client.query("SELECT count(*)::int AS n FROM ai_review_items WHERE status='resolved'");
    assert.equal(resolved.rows[0].n,2);
    await contacts.setAiReviewAttention(1,12,"Parking policy?","information");
    assert.equal(notified,3);
    const current = await client.query("SELECT count(*)::int AS n FROM ai_review_items WHERE status='pending'");
    assert.equal(current.rows[0].n,1);
  } finally {
    pool.query = oldQuery;
    telegram.sendHumanInterventionAlert = oldTelegram;
    push.sendContactAlertBestEffort = oldPush;
    await client.query("SET search_path TO public").catch(() => {});
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await client.end();
  }
});
