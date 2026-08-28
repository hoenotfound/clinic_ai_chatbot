const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const messagesRepo = require("../src/db/messagesRepo");

test("claims an inbound WhatsApp message with an atomic insert", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
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
