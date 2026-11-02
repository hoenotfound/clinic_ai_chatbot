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

test("archive API refuses unassigned and read-only staff before changing the contact", async (t) => {
  const router = require("../src/routes/conversations");
  const route = router.stack.find(layer =>
    layer.route?.path === "/:contactId/archive" && layer.route.methods.patch);
  assert.ok(route, "archive route must exist");
  const handler = route.route.stack.at(-1).handle;
  const originalQuery = pool.query;
  const originalGet = contactsRepo.getContactById;
  const originalArchive = contactsRepo.setInboxArchived;
  t.after(() => {
    pool.query = originalQuery;
    contactsRepo.getContactById = originalGet;
    contactsRepo.setInboxArchived = originalArchive;
  });

  let owner = "different-staff", changed = 0, fetched = 0;
  pool.query = async (sql, args) => {
    assert.match(sql, /FROM leads/);
    assert.deepEqual(args, [101]);
    return { rows: [{ owner_username: owner }] };
  };
  contactsRepo.getContactById = async id => {
    fetched++;
    assert.equal(id, 101);
    return { id: 101 };
  };
  contactsRepo.setInboxArchived = async (id, archived) => {
    changed++;
    assert.equal(id, 101);
    return { id, inbox_archived_at: archived ? "2026-11-02T00:00:00Z" : null };
  };
  async function call(permissions, body = { archived: true }) {
    const req = { params: { contactId: "101" }, body,
      user: { id: 5, username: "staff", role: "sales",
        permissions: { view_all_leads: false, view_assigned_leads: true,
          manage_assigned_leads: true, ...permissions } } };
    const res = {
      statusCode: 200, payload: null,
      status(code) { this.statusCode = code; return this; },
      json(body) { this.payload = body; return this; },
    };
    await handler(req, res);
    return res;
  }

  const unassigned = await call({});
  assert.equal(unassigned.statusCode, 403);
  assert.equal(changed, 0);
  assert.equal(fetched, 0);

  owner = "staff";
  const readOnly = await call({ manage_assigned_leads: false });
  assert.equal(readOnly.statusCode, 403);
  assert.equal(changed, 0);
  assert.equal(fetched, 0);

  const permitted = await call({});
  assert.equal(permitted.statusCode, 200);
  assert.equal(permitted.payload.archived, true);
  assert.equal(changed, 1);
  assert.equal(fetched, 1);
});
