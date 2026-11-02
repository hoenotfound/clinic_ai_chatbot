"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { pool } = require("../src/db/db");
const contactsRepo = require("../src/db/contactsRepo");

test("archive flag is a staff-only contact update and Inbox list exposes it", async (t) => {
  const prior = pool.query;
  t.after(() => { pool.query = prior; });
  let archived = false;
  pool.query = async (sql, params) => {
    if (sql.includes("UPDATE contacts") && sql.includes("inbox_archived_at")) {
      assert.deepEqual(params, [!archived, 101]);
      archived = !archived;
      assert.doesNotMatch(sql, /mode\s*=|needs_follow_up\s*=|whatsapp_opt_out_at\s*=/);
      return { rows: [{ id: 101, inbox_archived_at: archived ? new Date().toISOString() : null }] };
    }
    assert.match(sql, /c\.inbox_archived_at/);
    return { rows: [] };
  };
  assert.deepEqual(await contactsRepo.listConversations(), []);
  assert.ok((await contactsRepo.setInboxArchived(101, true)).inbox_archived_at);
  assert.equal((await contactsRepo.setInboxArchived(101, false)).inbox_archived_at, null);
});

test("PostgreSQL archive restores only on a genuinely newer inbound, not history imports or outbound", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const db = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  const schema = `archive_inbox_${process.pid}_${Date.now()}`;
  const prior = pool.query;
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    await db.query(`CREATE TABLE contacts (
      id integer PRIMARY KEY, mode text NOT NULL DEFAULT 'ai',
      needs_follow_up boolean NOT NULL DEFAULT true,
      inbox_archived_at timestamptz
    )`);
    await db.query(`CREATE TABLE messages (
      id serial PRIMARY KEY, contact_id integer REFERENCES contacts(id),
      role text, content text, created_at timestamptz DEFAULT now(),
      source_created_at timestamptz
    )`);
    const migration = fs.readFileSync(path.join(__dirname, "../src/db/migrations/115_inbox_chat_archiving.sql"), "utf8");
    await db.query(migration);
    await db.query("INSERT INTO contacts(id) VALUES (101)");
    pool.query = db.query.bind(db);

    await contactsRepo.setInboxArchived(101, true);
    const archived = (await db.query("SELECT inbox_archived_at FROM contacts WHERE id=101")).rows[0].inbox_archived_at;
    assert.ok(archived);
    await db.query("INSERT INTO messages(contact_id,role,content,source_created_at) VALUES (101,'user','old history',now()-interval '1 day')");
    assert.ok((await db.query("SELECT inbox_archived_at FROM contacts WHERE id=101")).rows[0].inbox_archived_at,
      "historical import cannot unarchive a newer staff decision");
    await db.query("INSERT INTO messages(contact_id,role,content) VALUES (101,'assistant','staff follow-up')");
    assert.ok((await db.query("SELECT inbox_archived_at FROM contacts WHERE id=101")).rows[0].inbox_archived_at,
      "outbound does not unarchive");
    await db.query("INSERT INTO messages(contact_id,role,content,source_created_at) VALUES (101,'user','new enquiry',now())");
    const after = (await db.query("SELECT inbox_archived_at, mode, needs_follow_up FROM contacts WHERE id=101")).rows[0];
    assert.equal(after.inbox_archived_at, null);
    assert.equal(after.mode, "ai");
    assert.equal(after.needs_follow_up, true);
  } finally {
    pool.query = prior;
    try { await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await db.end(); }
  }
});
