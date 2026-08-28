const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const telegramAlertRepo = require("../src/db/telegramAlertRepo");

test("ready Telegram summaries wait for inactivity and are invalidated only by a newer customer message", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /latest\.created_at <= now\(\) - \(\$1::integer \* interval '1 minute'\)/);
    assert.match(sql, /a\.status IN \('pending', 'sending'\)/);
    assert.match(sql, /a\.attempts < 3/);
    assert.match(sql, /newer_customer\.role = 'user'/);
    assert.match(sql, /newer_customer\.id > a\.through_message_id/);
    assert.doesNotMatch(sql, /a\.through_message_id = latest\.id/);
    assert.match(sql, /ORDER BY latest\.created_at ASC/);
    assert.deepEqual(params, [10, 5]);
    return { rows: [{ alert_id: 31, lead_id: 7 }] };
  };

  const rows = await telegramAlertRepo.findReadySummaries({
    inactivityMinutes: 10,
    limit: 5,
  });
  assert.deepEqual(rows, [{ alert_id: 31, lead_id: 7 }]);
});

test("queueing a newer scored snapshot supersedes older unsent snapshots", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO telegram_summary_alerts/.test(sql)) {
        return { rows: [{ id: 31 }] };
      }
      return { rows: [] };
    },
    release: () => calls.push({ sql: "RELEASE" }),
  };
  pool.connect = async () => client;

  const score = { temperature: "hot", summary: { chatSummary: "Booked" } };
  const queued = await telegramAlertRepo.queueSummary({
    leadId: 7,
    throughMessageId: 44,
    score,
  });

  assert.equal(calls[0].sql, "BEGIN");
  assert.match(calls[1].sql, /SET status = 'superseded'/);
  assert.deepEqual(calls[1].params, [7, 44]);
  assert.match(calls[2].sql, /ON CONFLICT \(lead_id, through_message_id\) DO NOTHING/);
  assert.deepEqual(calls[2].params, [7, 44, score]);
  assert.equal(calls[3].sql, "COMMIT");
  assert.equal(calls[4].sql, "RELEASE");
  assert.deepEqual(queued, { id: 31 });
});

test("failed Telegram sends return to pending while attempt count limits future retries", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /SET status = 'pending'/);
    assert.match(sql, /claimed_at = NULL/);
    assert.deepEqual(params, [31, "Telegram unavailable"]);
    return { rows: [{ id: 31, status: "pending", attempts: 3 }] };
  };

  const result = await telegramAlertRepo.markFailed(31, new Error("Telegram unavailable"));
  assert.deepEqual(result, { id: 31, status: "pending", attempts: 3 });
});
