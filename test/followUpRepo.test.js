const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const { CONVERSATION_LOCK_NAMESPACE } = require("../src/db/conversationLock");
const followUpRepo = require("../src/db/followUpRepo");

test("automated follow-up inserts take the conversation scoring lock", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`));
    assert.match(sql, /FROM messages, conversation_lock/);
    assert.deepEqual(params, [
      7,
      55,
      "Still interested?",
      "",
      120,
      "all",
      "2026-08-28T00:00:00.000Z",
    ]);
    return { rows: [] };
  };

  const saved = await followUpRepo.saveIfStillEligible({
    contactId: 7,
    triggerMessageId: 55,
    content: "Still interested?",
    mediaUrl: "",
    delayMinutes: 120,
    triggerMode: "all",
    activatedAt: "2026-08-28T00:00:00.000Z",
  });

  assert.equal(saved, null);
});
