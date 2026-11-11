"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
const { pool } = require("../src/db/db");
const contactsRepo = require("../src/db/contactsRepo");
const alerts = require("../src/services/telegramImmediateAlertService");
const push = require("../src/services/webPushNotificationService");

test("Postgres groups repeat urinary reviews until they are resolved, but keeps all questions", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const client = new Client({connectionString:process.env.TEST_DATABASE_URL,ssl:false});
  const schema = "neutro_review_dedup_" + process.pid + "_" + Date.now();
  const oldQuery = pool.query;
  const oldAlert = alerts.sendAiReviewAlert;
  const oldPush = push.sendContactAlertBestEffort;
  await client.connect();
  try {
    await client.query("CREATE SCHEMA " + schema);
    await client.query("SET search_path TO " + schema);
    await client.query(
      "CREATE TABLE contacts (" +
      "id integer primary key,mode text default 'ai'," +
      "needs_attention boolean default false,attention_reason text," +
      "updated_at timestamptz default now());" +
      "CREATE TABLE messages (id integer primary key," +
      "contact_id integer references contacts(id),role text,content text);"
    );
    await client.query(fs.readFileSync(path.join(__dirname,
      "../src/db/migrations/064_ai_review_items.sql"),"utf8"));
    await client.query(
      "INSERT INTO contacts(id) VALUES (9006);" +
      "INSERT INTO messages(id,contact_id,role,content) VALUES " +
      "(1,9006,'user','漏尿问题')," +
      "(2,9006,'user','尿失禁问题')," +
      "(3,9006,'user','怀孕是否适合治疗？')," +
      "(4,9006,'user','还是有漏尿');"
    );
    pool.query = (...args) => client.query(...args);
    let alertsSent=0, pushesSent=0;
    alerts.sendAiReviewAlert=async()=>{alertsSent++;return{status:"queued"};};
    push.sendContactAlertBestEffort=()=>{pushesSent++;};

    await contactsRepo.setAiReviewAttention(9006,1,"漏尿问题","clinical");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(alertsSent,1);

    await contactsRepo.setAiReviewAttention(9006,2,"尿失禁问题","clinical");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(alertsSent,1,"same unresolved urinary concern should not alert again");
    assert.equal(pushesSent,1);

    await contactsRepo.setAiReviewAttention(9006,3,"怀孕是否适合治疗？","clinical");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(alertsSent,2,"a separate medical issue still alerts");

    const persisted = await client.query(
      "SELECT inbound_message_id,category,status FROM ai_review_items ORDER BY inbound_message_id");
    assert.deepEqual(persisted.rows.map(r=>r.inbound_message_id),[1,2,3]);
    assert.ok(persisted.rows.every(r=>r.category==="clinical"&&r.status==="pending"));

    await client.query(
      "UPDATE ai_review_items SET status='resolved',resolved_at=now() " +
      "WHERE contact_id=9006 AND inbound_message_id IN (1,2)"
    );
    await contactsRepo.setAiReviewAttention(9006,4,"还是有漏尿","clinical");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(alertsSent,3,"new clinical issue after resolution alerts normally");
    assert.equal(pushesSent,3);
    const reviews=await client.query(
      "SELECT count(*)::int AS n FROM ai_review_items WHERE contact_id=9006");
    assert.equal(reviews.rows[0].n,4,"all messages remain individually reviewable");
  } finally {
    pool.query=oldQuery;
    alerts.sendAiReviewAlert=oldAlert;
    push.sendContactAlertBestEffort=oldPush;
    try {
      await client.query("SET search_path TO public");
      await client.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    } finally {
      await client.end();
    }
  }
});
