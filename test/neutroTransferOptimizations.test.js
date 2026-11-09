"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const contactsRepo = require("../src/db/contactsRepo");
const service = require("../src/services/whatsappSecondaryFollowUpService");
const marketing = require("../src/services/whatsappSecondaryMarketingFollowUpService");
const { listInboxPageIndex, resetIndexCacheForTests } = require("../src/db/inboxPageIndexRepo");

test("secondary follow-up shortlist preserves the current main branch safety windows", () => {
  for (const [module, window] of [[service, "24 hours"], [marketing, "5 days"]]) {
    assert.match(module.CANDIDATES_SQL, /SELECT DISTINCT recent\.contact_id/);
    assert.ok(module.CANDIDATES_SQL.includes(
      "recent.created_at > $4::timestamptz - INTERVAL '" + window + "'"
    ), "Retain the established recent-inbound shortlist");
    assert.match(module.CANDIDATES_SQL, /sc\.contact_id=recent_contact\.contact_id/);
    assert.match(module.POTENTIAL_DUE_SQL, /recent_contact/);
    assert.match(module.CANDIDATES_SQL, /pending|opt_out|appointment/i);
  }
  assert.match(marketing.EXTENDED_CANDIDATES_SQL, /recent_contact/);
  assert.match(marketing.EXTENDED_CANDIDATES_SQL,
    /recent\.created_at > \$4::timestamptz - INTERVAL '9 days'/);
  assert.match(marketing.RECHECK_SQL, /recent_contact/);
  assert.match(marketing.EXTENDED_RECHECK_SQL, /recent_contact/);
  assert.match(service.CANDIDATES_SQL, /whatsapp_opt_out_at IS NULL/);
  assert.match(marketing.CANDIDATES_SQL, /whatsapp_marketing_opt_out_at IS NULL/);
});

test("Contacts page uses bounded SQL with server-side search and assignment filtering", async (t) => {
  const original = pool.query;
  t.after(() => { pool.query = original; });
  pool.query = async (sql, params) => {
    assert.match(sql, /COUNT\(\*\) OVER\(\)::int AS total/);
    assert.match(sql, /LIMIT \$5 OFFSET \$6/);
    assert.match(sql, /lead\.owner_username = \$4/);
    assert.match(sql, /JOIN contacts c ON c\.id = page\.id/);
    assert.match(sql, /\$7::integer\[\] IS NULL OR c\.id = ANY\(\$7::integer\[\]\)/);
    assert.deepEqual(params, ["Sarah", "%Sarah%", "mine", "staff1", 2, 0, [9, 10]]);
    return { rows: [
      { id: 10, channel: "whatsapp", whatsapp_number: "601100000010", total: 9, message_count: 3 },
      { id: 9, channel: "whatsapp", whatsapp_number: "601100000009", total: 9, message_count: 1 },
    ] };
  };
  const page = await contactsRepo.listContactsPage({
    search: "Sarah", assignment: "mine", currentUsername: "staff1",
    limit: 2, offset: 0, accessibleContactIds: [9, 10],
  });
  assert.equal(page.total, 9);
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 2);
  assert.deepEqual(page.items.map(item => item.id), [10, 9]);
  assert.equal(Object.hasOwn(page.items[0], "total"), false);
  assert.equal(page.ownerOptions, null);
});

test("Contacts page returns empty pages and rejects invalid limits without querying", async (t) => {
  const original = pool.query;
  t.after(() => { pool.query = original; });
  let calls = 0;
  pool.query = async () => { calls++; return { rows: [] }; };
  const page = await contactsRepo.listContactsPage({ limit: 60, offset: 0, search: "missing" });
  assert.deepEqual(page.items, []);
  assert.equal(page.total, 0);
  assert.equal(page.hasMore, false);
  await assert.rejects(contactsRepo.listContactsPage({ limit: 500 }), /Invalid contacts page/);
  await assert.rejects(contactsRepo.listContactsPage({ offset: -1 }), /Invalid contacts page/);
  await assert.rejects(contactsRepo.listContactsPage({ assignment: "other" }), /Invalid contact assignment filter/);
  assert.equal(calls, 1);
});

test("restricted staff cannot request an unscoped page or unrelated owners", async (t) => {
  const original = pool.query;
  t.after(() => { pool.query = original; });
  let calls = 0;
  pool.query = async () => { calls++; throw new Error("Must not query"); };
  const empty = await contactsRepo.listContactsPage({
    accessibleContactIds: [], includeOwners: true,
  });
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.ownerOptions, []);
  await assert.rejects(contactsRepo.listContactsPage({
    accessibleContactIds: [0],
  }), /Invalid contact access scope/);
  assert.equal(calls, 0);
});

test("Inbox page index caches unscoped results only while the WAL revision stays identical", async (t) => {
  const originalQuery = pool.query;
  const originalFlag = process.env.INBOX_INDEX_WAL_CACHE_ENABLED;
  t.after(() => {
    pool.query = originalQuery;
    if (originalFlag === undefined) delete process.env.INBOX_INDEX_WAL_CACHE_ENABLED;
    else process.env.INBOX_INDEX_WAL_CACHE_ENABLED = originalFlag;
    resetIndexCacheForTests();
  });
  resetIndexCacheForTests();
  process.env.INBOX_INDEX_WAL_CACHE_ENABLED = "true";
  let wal = "0/A";
  let indexQueries = 0;
  pool.query = async (sql) => {
    if (sql.includes("pg_current_wal_lsn()")) return { rows: [{ wal_lsn: wal }] };
    indexQueries++;
    return { rows: [{ contact_id: indexQueries }] };
  };
  assert.equal((await listInboxPageIndex({ query: "" }))[0].contact_id, 1);
  assert.equal((await listInboxPageIndex({ query: "" }))[0].contact_id, 1);
  assert.equal(indexQueries, 1);
  wal = "0/B";
  assert.equal((await listInboxPageIndex({ query: "" }))[0].contact_id, 2);
  assert.equal((await listInboxPageIndex({ query: "hello" }))[0].contact_id, 3);
  assert.equal((await listInboxPageIndex({ query: "hello", accessibleContactIds: [5] }))[0].contact_id, 4);
  assert.equal(indexQueries, 4);
});
