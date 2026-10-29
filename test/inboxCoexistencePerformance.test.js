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
  delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;

  pool.query = async (sql, params) => {
    assert.deepEqual(params, []);
    assert.match(sql, /sa\.coexistence_enabled IS DISTINCT FROM TRUE/);
    assert.match(sql, /OR m\.created_at IS NOT NULL/);
    assert.match(sql, /OR c\.needs_attention = TRUE/);
    assert.match(sql, /OR c\.needs_follow_up = TRUE/);
    assert.match(sql, /OR c\.is_unread = TRUE/);
    assert.match(sql, /OR c\.mode = 'human'/);
    assert.match(sql, /EXISTS \(SELECT 1 FROM leads retained/);
    assert.match(sql, /c\.whatsapp_sender_id IS NULL/);
    assert.match(sql, /c\.created_at/);
    return { rows: [] };
  };
  assert.deepEqual(await contactsRepo.listConversations(), []);
});

test("direct linked archived contacts can be fetched with sender identity intact", async (t) => {
  const previous = process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  const original = pool.query;
  t.after(() => {
    pool.query = original;
    if (previous === undefined) delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = previous;
  });
  process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = "true";
  pool.query = async (sql, params) => {
    assert.deepEqual(params, [997]);
    assert.match(sql, /AND c\.id = \$1/);
    assert.doesNotMatch(sql, /sa\.coexistence_enabled IS DISTINCT FROM TRUE/);
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
      assert.doesNotMatch(sql, /sa\.coexistence_enabled IS DISTINCT FROM TRUE/);
      return { rows: [] };
    };
    assert.deepEqual(await contactsRepo.listConversations(), []);
  }
});
