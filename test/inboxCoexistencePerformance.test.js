const test = require("node:test");
const assert = require("node:assert/strict");
const { pool } = require("../src/db/db");
const contactsRepo = require("../src/db/contactsRepo");

test("Coexistence contact-only import is hidden only from the Inbox list", async (t) => {
  const previous = process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  const previousVisibility = process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
  const original = pool.query;
  t.after(() => {
    pool.query = original;
    if (previous === undefined) delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = previous;
    if (previousVisibility === undefined) delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
    else process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = previousVisibility;
  });
  process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = "true";
  process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = "true";

  pool.query = async (sql, params) => {
    assert.deepEqual(params, []);
    assert.match(sql, /WITH eligible_inbox_contacts AS MATERIALIZED/);
    assert.match(sql, /account\.coexistence_enabled = TRUE/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM messages any_message/);
    assert.match(sql, /NOT EXISTS \(SELECT 1 FROM leads existing_lead/);
    assert.match(sql, /c\.needs_attention IS DISTINCT FROM TRUE/);
    assert.match(sql, /c\.needs_follow_up IS DISTINCT FROM TRUE/);
    assert.match(sql, /c\.is_unread IS DISTINCT FROM TRUE/);
    assert.match(sql, /c\.mode IS DISTINCT FROM 'human'/);
    assert.match(sql, /c\.whatsapp_sender_id IS NOT NULL/);
    assert.match(sql, /c\.created_at/);
    return { rows: [] };
  };
  assert.deepEqual(await contactsRepo.listConversations(), []);
});

test("direct linked archived contacts can be fetched with sender identity intact", async (t) => {
  const previousVisibility = process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
  const previous = process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  const original = pool.query;
  t.after(() => {
    pool.query = original;
    if (previous === undefined) delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = previous;
    if (previousVisibility === undefined) delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
    else process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = previousVisibility;
  });
  process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = "true";
  process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = "true";
  pool.query = async (sql, params) => {
    assert.deepEqual(params, [997]);
    assert.match(sql, /AND c\.id = \$1/);
    assert.doesNotMatch(sql, /WITH eligible_inbox_contacts AS MATERIALIZED/);
    return { rows: [] };
  };
  assert.deepEqual(await contactsRepo.listConversations({
    contactId: 997, includeEmptyCoexistenceContacts: true,
  }), []);
});

test("single-number deployments and opt-out preserve legacy Inbox SQL", async (t) => {
  const previous = process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  const previousVisibility = process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
  const original = pool.query;
  t.after(() => {
    pool.query = original;
    if (previous === undefined) delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = previous;
    if (previousVisibility === undefined) delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
    else process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = previousVisibility;
  });
  for (const enabled of ["false", "true"]) {
    process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = enabled;
    process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = "false";
    pool.query = async (sql) => {
      assert.doesNotMatch(sql, /WITH eligible_inbox_contacts AS MATERIALIZED/);
      return { rows: [] };
    };
    assert.deepEqual(await contactsRepo.listConversations(), []);
  }
});

test("new exclusion is OFF by default even when two business numbers are active", async (t) => {
  const oldFlag = process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
  const oldRead = process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  const original = pool.query;
  t.after(() => {
    pool.query = original;
    if (oldFlag === undefined) delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
    else process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = oldFlag;
    if (oldRead === undefined) delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = oldRead;
  });
  process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = "true";
  delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
  pool.query = async (sql) => {
    assert.doesNotMatch(sql, /WITH eligible_inbox_contacts AS MATERIALIZED/);
    return { rows: [] };
  };
  assert.deepEqual(await contactsRepo.listConversations(), []);
});
