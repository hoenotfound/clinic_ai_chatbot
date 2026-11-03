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

test("scoped Inbox list filters inside Neon before pending review and message hydration",async(t)=>{
  const originalQuery=pool.query;
  const originalMulti=process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  const originalHide=process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
  t.after(()=>{
    pool.query=originalQuery;
    if(originalMulti===undefined)delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED=originalMulti;
    if(originalHide===undefined)delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
    else process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS=originalHide;
  });
  process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED="true";
  process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS="true";
  let queries=0;
  pool.query=async(sql,params)=>{
    queries++;
    assert.deepEqual(params,[[11,17]]);
    assert.match(sql,/SELECT c\\.id FROM contacts c\\s+WHERE c\\.id = ANY\\(\\$1::integer\\[\\]\\) AND NOT/);
    assert.match(sql,/WHERE \\(m\\.created_at IS NOT NULL OR c\\.channel = 'whatsapp'\\)\\s+AND c\\.id = ANY\\(\\$1::integer\\[\\]\\)/);
    assert.match(sql,/pending_ai_review_rows AS MATERIALIZED/);
    return{rows:[]};
  };
  assert.deepEqual(await contactsRepo.listConversations({accessibleContactIds:[11,17]}),[]);
  assert.equal(queries,1);
  assert.deepEqual(await contactsRepo.listConversations({accessibleContactIds:[]}),[]);
  assert.equal(queries,1,"no-permission staff must never run a full Inbox query");
  await assert.rejects(contactsRepo.listConversations({accessibleContactIds:["11"]}),/invalid contact ID/);
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

test("multi-number Inbox hides untouched Coexistence contacts by default with explicit rollback", async (t) => {
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
  let expectedFilter = true;
  pool.query = async (sql, params) => {
    assert.deepEqual(params, []);
    if (expectedFilter) {
      assert.match(sql, /WITH eligible_inbox_contacts AS MATERIALIZED/);
      assert.match(sql, /NOT EXISTS \(SELECT 1 FROM messages any_message/);
      assert.match(sql, /NOT EXISTS \(SELECT 1 FROM leads existing_lead/);
      assert.match(sql, /c.needs_attention IS DISTINCT FROM TRUE/);
    } else {
      assert.doesNotMatch(sql, /WITH eligible_inbox_contacts AS MATERIALIZED/);
    }
    return { rows: [] };
  };

  assert.deepEqual(await contactsRepo.listConversations(), []);
  // A production rollback must need no code edit or database migration.
  process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = "false";
  expectedFilter = false;
  assert.deepEqual(await contactsRepo.listConversations(), []);
  // Re-enabling explicitly remains supported.
  process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = "true";
  expectedFilter = true;
  assert.deepEqual(await contactsRepo.listConversations(), []);
});

test("single-contact summary still requires explicit archived access", async (t) => {
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
  let expectedArchivedLookup = false;
  pool.query = async (sql, params) => {
    assert.deepEqual(params, [997]);
    assert.match(sql, /AND c\.id = \$1/);
    if (expectedArchivedLookup) {
      assert.doesNotMatch(sql, /WITH eligible_inbox_contacts AS MATERIALIZED/);
    } else {
      assert.match(sql, /WITH eligible_inbox_contacts AS MATERIALIZED/);
      // A single-contact lookup must constrain the materialized CTE itself,
      // rather than building candidates for every imported contact first.
      assert.match(sql, /SELECT c\.id FROM contacts c\s+WHERE c\.id = \$1\s+AND NOT \(/);
    }
    return { rows: [] };
  };
  assert.deepEqual(await contactsRepo.listConversations({ contactId: 997 }), []);
  expectedArchivedLookup = true;
  assert.deepEqual(await contactsRepo.listConversations({
    contactId: 997, includeEmptyCoexistenceContacts: true,
  }), []);
});


test("Inbox pending review summaries use one shared aggregation in both visibility modes", async (t) => {
  const previousRead = process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
  const previousHide = process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
    if (previousRead === undefined) delete process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED;
    else process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = previousRead;
    if (previousHide === undefined) delete process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS;
    else process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = previousHide;
  });
  process.env.WHATSAPP_MULTI_NUMBER_READ_ENABLED = "true";

  for (const hide of ["true", "false"]) {
    process.env.INBOX_HIDE_EMPTY_COEX_CONTACTS = hide;
    pool.query = async (sql, params) => {
      assert.deepEqual(params, []);
      assert.match(sql, /pending_ai_review_rows AS MATERIALIZED/);
      assert.match(sql, /pending_ai_reviews AS MATERIALIZED/);
      assert.match(sql, /ROW_NUMBER\(\) OVER/);
      assert.match(sql, /PARTITION BY r\.contact_id ORDER BY r\.created_at DESC, r\.id DESC/);
      assert.match(sql, /COUNT\(\*\)::integer AS pending_review_count/);
      assert.match(sql, /FILTER \(WHERE r\.review_rank <= 10\)/);
      assert.match(sql, /FILTER \(WHERE r\.review_rank <= 25\)/);
      assert.match(sql, /LEFT JOIN pending_ai_reviews pending_reviews/);
      assert.match(sql, /COALESCE\(pending_reviews\.pending_review_count, 0\)/);
      assert.match(sql, /COALESCE\(pending_reviews\.pending_review_items, '\[\]'::jsonb\)/);
      assert.doesNotMatch(sql, /\(SELECT COUNT\(\*\)::integer FROM ai_review_items r/);
      if (hide === "true") {
        assert.match(sql, /WITH eligible_inbox_contacts AS MATERIALIZED/);
        assert.match(sql, /EXISTS \(SELECT 1 FROM eligible_inbox_contacts eligible WHERE eligible\.id = r\.contact_id\)/);
      } else {
        assert.doesNotMatch(sql, /WITH eligible_inbox_contacts AS MATERIALIZED/);
        assert.doesNotMatch(sql, /EXISTS \(SELECT 1 FROM eligible_inbox_contacts eligible WHERE eligible\.id = r\.contact_id\)/);
      }
      return { rows: [] };
    };
    assert.deepEqual(await contactsRepo.listConversations(), []);
  }
});
