"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { pool } = require("../src/db/db");
const { runMigrations } = require("../src/db/migrationRunner");
const contactsRepo = require("../src/db/contactsRepo");
const {listInboxPageIndex}=require("../src/db/inboxPageIndexRepo");
const {inboxPageModel}=require("../src/services/inboxPaginationService");

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
    // Two pending reviews and a resolved review must retain exactly the same
    // Inbox count, newest-25 objects and newest-10 ordered staff summaries.
    const secondReviewMessage = (await db.query(
      "INSERT INTO messages (contact_id,role,content) VALUES ($1,'user','Review follow-up') RETURNING id",
      [ids[0].id]
    )).rows[0].id;
    const resolvedReviewMessage = (await db.query(
      "INSERT INTO messages (contact_id,role,content) VALUES ($1,'user','Already resolved') RETURNING id",
      [ids[0].id]
    )).rows[0].id;
    await db.query(
      `INSERT INTO ai_review_items
       (contact_id,inbound_message_id,category,summary,status,created_at)
       VALUES ($1,$2,'clinical','First question','pending','2026-10-01T01:00:00Z'),
              ($1,$3,'clinical','Second question','pending','2026-10-01T02:00:00Z'),
              ($1,$4,'information','No longer pending','resolved','2026-10-01T03:00:00Z')`,
      [ids[0].id, historical, secondReviewMessage, resolvedReviewMessage]
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
    const reviewed = visible.find(row => row.contact_id === ids[0].id);
    assert.equal(reviewed.pending_review_count, 2);
    assert.equal(reviewed.pending_review_summaries,
      `[#${historical}] First question\n[#${secondReviewMessage}] Second question`);
    assert.deepEqual(reviewed.pending_review_items.map(item => ({
      messageId: item.messageId, summary: item.summary, category: item.category,
    })), [
      { messageId: historical, summary: "First question", category: "clinical" },
      { messageId: secondReviewMessage, summary: "Second question", category: "clinical" },
    ]);
    assert.equal(visible.find(row => row.contact_id === ids[1].id).pending_review_count, 0);
    assert.deepEqual(visible.find(row => row.contact_id === ids[1].id).pending_review_items, []);


    // Real Postgres proof: restricted staff must not transfer unrelated rows,
    // even when thousands of imported contacts exist.
    const scopedRows = await contactsRepo.listConversations({
      accessibleContactIds: [ids[0].id, ids[5].id],
    });
    assert.deepEqual(scopedRows.map(row => row.contact_id), [ids[0].id]);
    assert.equal(scopedRows[0].pending_review_count, 2);
    assert.deepEqual(await contactsRepo.listConversations({
      accessibleContactIds: [],
    }), []);
    const singleWithScope = await contactsRepo.listConversations({
      contactId: ids[0].id,
      accessibleContactIds: [ids[0].id],
    });
    assert.equal(singleWithScope.length, 1);
    assert.deepEqual(await contactsRepo.listConversations({
      contactId: ids[0].id,
      accessibleContactIds: [ids[1].id],
    }), []);

    // Lightweight paged index must preserve the original visibility and
    // ordering, but transfer no review JSON or full last-message content.
    const index = await listInboxPageIndex();
    const firstPage = inboxPageModel(index.map(contactsRepo.presentPortalContact),
      {},{limit:3,now:Date.parse("2026-11-03T00:00:00Z")});
    assert.equal(index.length,visible.length);
    assert.equal(firstPage.ids.length,3);
    assert.equal(firstPage.hasMore,true);
    const hydrated = await contactsRepo.listConversations({
      contactIds:firstPage.ids,
    });
    assert.equal(hydrated.length,3);
    assert.deepEqual(new Set(hydrated.map(x=>x.contact_id)),
      new Set(firstPage.ids));
    const fromIndex = await listInboxPageIndex({
      accessibleContactIds:[ids[0].id,ids[5].id,primary],
    });
    assert.deepEqual(new Set(fromIndex.map(x=>x.contact_id)),
      new Set([ids[0].id,primary]));
    const archivedSearch = await listInboxPageIndex({
      accessibleContactIds:[ids[0].id],
      query:"already resolved",
    });
    assert.equal(archivedSearch[0].search_match,true);
    assert.equal(inboxPageModel(archivedSearch,{query:"already resolved"},
      {limit:100}).total,1);
    const unreadPage=inboxPageModel(index,{status:"unread"});
    assert.ok(unreadPage.ids.includes(ids[4].id),
      "unread contacts beyond the first page remain filterable");
    assert.deepEqual(await contactsRepo.listConversations({contactIds:[]}),[]);

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
