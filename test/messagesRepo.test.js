const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const { CONVERSATION_LOCK_NAMESPACE } = require("../src/db/conversationLock");
const messagesRepo = require("../src/db/messagesRepo");

test("claims an inbound WhatsApp message with an atomic insert", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`));
    assert.match(sql, /ON CONFLICT \(whatsapp_message_id\) DO NOTHING/);
    assert.deepEqual(params, [7, "Hello", "wamid-inbound", null, null]);
    return { rows: [{ id: 41, contact_id: 7, content: "Hello" }] };
  };

  const claimed = await messagesRepo.saveInboundMessageIfNew(
    7,
    "Hello",
    "wamid-inbound"
  );
  assert.equal(claimed.id, 41);
});

test("returns null when another webhook already claimed the message", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async () => ({ rows: [] });
  const claimed = await messagesRepo.saveInboundMessageIfNew(
    7,
    "Hello",
    "wamid-inbound"
  );
  assert.equal(claimed, null);
});

test("outbound message writes take the conversation scoring lock", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`));
    assert.match(sql, /FROM conversation_lock/);
    assert.deepEqual(params, [7, "assistant", "Hello", null, null, null, null, null]);
    return { rows: [{ id: 42, contact_id: 7, content: "Hello" }] };
  };

  const saved = await messagesRepo.saveMessage(7, "assistant", "Hello");
  assert.equal(saved.id, 42);
});

test("inbound transcript updates take the conversation scoring lock", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`));
    assert.match(sql, /UPDATE messages/);
    assert.deepEqual(params, [42, 7, "Updated", null, null]);
    return { rows: [{ id: 42, contact_id: 7, content: "Updated" }] };
  };

  const saved = await messagesRepo.updateInboundMessage(42, 7, "Updated", null, null);
  assert.equal(saved.content, "Updated");
});
