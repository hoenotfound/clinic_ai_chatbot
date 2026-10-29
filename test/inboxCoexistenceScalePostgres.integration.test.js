"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { pool } = require("../src/db/db");
const { runMigrations } = require("../src/db/migrationRunner");
const contactsRepo = require("../src/db/contactsRepo");

// Uses only an isolated, throwaway test schema. Never connects to production.
test("8,000 Coexistence address-book imports keep real conversations and sender identity intact", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const connectionString = process.env.TEST_DATABASE_URL;
  const db = new Client({ connectionString });
  const schema = `inbox_scale_${process.pid}_${Date.now()}`;
  const oldQuery = pool.query;
  const oldMulti = process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  const oldHide = process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
  await db.connect();
  try {
    await db.query(`CREATE SCHEMA "${schema}"`);
    await db.query(`SET search_path TO "${schema}"`);
    const scoped = {
      async connect() {
        const client = new Client({ connectionString });
        await client.connect();
        await client.query(`SET search_path TO "${schema}"`);
        return { query: (...args) => client.query(...args), release: () => client.end() };
      },
    };
    await runMigrations(scoped, { quiet: true });
    const sender = (await db.query(
      `INSERT INTO whatsapp_sender_accounts
       (sender_key,meta_phone_number_id,meta_account_id,display_name,state,coexistence_enabled)
       VALUES ('secondary','100000000000602','200000000000602','Second business number','active',TRUE)
       RETURNING id`
    )).rows[0].id;
    await db.query(
      `INSERT INTO contacts (whatsapp_number,whatsapp_sender_id)
       SELECT '6018' || LPAD(serial::text,8,'0'),$1
       FROM generate_series(1,8000) AS serial`, [sender]
    );
    await db.query(
      `INSERT INTO whatsapp_sender_conversations
       (sender_id, customer_wa_id, contact_id, state)
       SELECT $1,c.whatsapp_number,c.id,'bound'
       FROM contacts c WHERE c.whatsapp_sender_id=$1`, [sender]
    );
    const ids = (await db.query(
      "SELECT id,whatsapp_number FROM contacts WHERE whatsapp_sender_id=$1 ORDER BY id LIMIT 6",
      [sender]
    )).rows;
    const historical = (await db.query(
      "INSERT INTO messages (contact_id,role,content) VALUES ($1,'user','Imported history') RETURNING id",
      [ids[0].id]
    )).rows[0].id;
    await db.query(
      `INSERT INTO whatsapp_sender_coexistence_history_messages
       (message_id,sender_id,source_wamid_hash)
       VALUES ($1,$2,$3)`, [historical,sender,"a".repeat(64)]
    );
    await db.query("INSERT INTO messages (contact_id,role,content) VALUES ($1,'user','New inbound')", [ids[1].id]);
    await db.query("UPDATE contacts SET needs_attention=TRUE WHERE id=$1", [ids[2].id]);
    await db.query("UPDATE contacts SET mode='human' WHERE id=$1", [ids[3].id]);
    await db.query("UPDATE contacts SET is_unread=TRUE WHERE id=$1", [ids[4].id]);

    // A customer's same phone number belongs to two separate business senders.
    const primary = (await db.query(
      "INSERT INTO contacts (whatsapp_number) VALUES ($1) RETURNING id",
      [ids[0].whatsapp_number]
    )).rows[0].id;
    process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = "true";
    process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = "true";
    pool.query = (...args) => db.query(...args);
    const visible = await contactsRepo.listConversations();
    const visibleIds = new Set(visible.map(row => row.contact_id));
    assert.equal(visibleIds.size, 6, "Five actionable second-number contacts and primary legacy contact");
    for (let i = 0; i < 5; i++) assert.ok(visibleIds.has(ids[i].id));
    assert.ok(visibleIds.has(primary));
    assert.ok(!visibleIds.has(ids[5].id), "Untouched contact-only import is not an active conversation");
    assert.equal(visible.find(row => row.contact_id === ids[0].id).whatsapp_sender_key, "secondary");

    const deepLink = await contactsRepo.listConversations({
      contactId: ids[5].id, includeEmptyCoexistenceContacts: true,
    });
    assert.equal(deepLink.length, 1);
    assert.equal(deepLink[0].whatsapp_sender_key, "secondary");

    const directory = await contactsRepo.searchConversationDirectory({
      term: ids[5].whatsapp_number, accessibleContactIds: [ids[5].id],
    });
    assert.equal(directory.length, 1);
    assert.equal(directory[0].contact_id, ids[5].id);
    const denied = await contactsRepo.searchConversationDirectory({
      term: ids[5].whatsapp_number, accessibleContactIds: [primary],
    });
    assert.deepEqual(denied, []);
    assert.deepEqual(await contactsRepo.searchConversationDirectory({
      term: ids[5].whatsapp_number, accessibleContactIds: [],
    }), []);

    // Rollback turns only the Inbox exclusion off and restores all contacts.
    process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = "false";
    const afterRollback = await contactsRepo.listConversations();
    assert.equal(afterRollback.length, 8001);
    const archiveAfterRollback = afterRollback.find(row => row.contact_id === ids[5].id);
    assert.equal(archiveAfterRollback.whatsapp_sender_key, "secondary");
  } finally {
    pool.query = oldQuery;
    if (oldMulti === undefined) delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = oldMulti;
    if (oldHide === undefined) delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
    else process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = oldHide;
    await db.query("SET search_path TO public").catch(() => {});
    await db.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
    await db.end();
  }
});
