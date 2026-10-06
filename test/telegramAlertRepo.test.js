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
    assert.match(sql, /a\.attempts = 0/);
    assert.match(sql, /WHEN 1 THEN interval '1 minute'/);
    assert.match(sql, /WHEN 2 THEN interval '5 minutes'/);
    assert.match(sql, /newer_customer\.role = 'user'/);
    assert.match(sql, /newer_customer\.id > a\.through_message_id/);
    assert.doesNotMatch(sql, /a\.through_message_id = latest\.id/);
    assert.match(sql, /l\.temperature AS current_temperature/);
    assert.match(sql, /ORDER BY latest\.created_at ASC/);
    assert.match(sql, /telegram_immediate_alerts immediate/);
    assert.match(sql, /immediate\.alert_type IN \('human_intervention', 'booking_ready', 'staff_waiting'\)/);
    assert.match(sql, /immediate\.status IN \('pending', 'sending', 'sent'\)/);
    assert.match(sql, /COALESCE\(a\.score_data->>'alertType', ''\) = 'ai_scoring_failed'/);
    assert.deepEqual(params, [10, 5, telegramAlertRepo.ACTIONABLE_SUMMARY_SUPPRESSION_MINUTES]);
    return { rows: [{ alert_id: 31, lead_id: 7 }] };
  };

  const rows = await telegramAlertRepo.findReadySummaries({
    inactivityMinutes: 10,
    limit: 5,
  });
  assert.deepEqual(rows, [{ alert_id: 31, lead_id: 7 }]);
});

test("claim rechecks inactivity and newer customer messages atomically", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /UPDATE telegram_summary_alerts a/);
    assert.match(sql, /newer_customer\.role = 'user'/);
    assert.match(sql, /newer_customer\.id > a\.through_message_id/);
    assert.match(sql, /latest\.created_at/);
    assert.match(sql, /\$2::integer \* interval '1 minute'/);
    assert.match(sql, /a\.attempts = 0/);
    assert.match(sql, /WHEN 1 THEN interval '1 minute'/);
    assert.match(sql, /WHEN 2 THEN interval '5 minutes'/);
    assert.match(sql, /l\.temperature AS current_temperature/);
    assert.match(sql, /telegram_immediate_alerts immediate/);
    assert.deepEqual(params, [31, 10, telegramAlertRepo.ACTIONABLE_SUMMARY_SUPPRESSION_MINUTES]);
    return {
      rows: [{
        alert_id: 31,
        lead_id: 7,
        contact_id: 12,
        current_temperature: "warm",
      }],
    };
  };

  const claim = await telegramAlertRepo.claimSummary(31, 10);
  assert.equal(claim.alert_id, 31);
  assert.equal(claim.current_temperature, "warm");
});

test("actionable alert coverage is state-aware and manual-review summaries are exempt", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  const calls = [];
  pool.query = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT immediate\.status/.test(sql)) {
      assert.match(sql, /status IN \('pending', 'sending', 'sent'\)/);
      assert.match(sql, /alert_type IN \('human_intervention', 'booking_ready', 'staff_waiting'\)/);
      assert.match(sql, /alertType', ''\) <> 'ai_scoring_failed'/);
      return { rows: [{ status: "sent" }] };
    }
    if (/UPDATE telegram_summary_alerts a/.test(sql) && /FROM leads l/.test(sql)) {
      assert.match(sql, /immediate\.status = 'sent'/);
      assert.match(sql, /alertType', ''\) <> 'ai_scoring_failed'/);
      return { rows: [{ id: 33 }] };
    }
    if (/SET status = 'superseded'/.test(sql)) {
      return { rows: [{ id: 31, status: "superseded" }] };
    }
    if (/SET status = 'pending'/.test(sql) && /attempts = GREATEST/.test(sql)) {
      return { rows: [{ id: 32, status: "pending", attempts: 0 }] };
    }
    throw new Error("Unexpected SQL in anti-spam repo test");
  };

  assert.equal(
    await telegramAlertRepo.findActionableCoverage(31),
    "sent"
  );
  assert.deepEqual(
    await telegramAlertRepo.markSuperseded(31),
    { id: 31, status: "superseded" }
  );
  assert.deepEqual(
    await telegramAlertRepo.releaseClaim(32),
    { id: 32, status: "pending", attempts: 0 }
  );
  assert.deepEqual(
    await telegramAlertRepo.supersedeCoveredSummaries(),
    [{ id: 33 }]
  );
  assert.equal(calls.length, 4);
});

test("queueing a newer scored snapshot supersedes only older unsent snapshots under a per-lead lock", async (t) => {
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
  assert.match(calls[1].sql, /pg_advisory_xact_lock/);
  assert.deepEqual(calls[1].params, [telegramAlertRepo.QUEUE_LOCK_NAMESPACE, 7]);
  assert.match(calls[2].sql, /SET status = 'superseded'/);
  assert.match(calls[2].sql, /through_message_id < \$2/);
  assert.deepEqual(calls[2].params, [7, 44]);
  assert.match(calls[3].sql, /ON CONFLICT \(lead_id, through_message_id\) DO NOTHING/);
  assert.match(calls[3].sql, /newer\.through_message_id > \$2/);
  assert.deepEqual(calls[3].params, [7, 44, score]);
  assert.equal(calls[4].sql, "COMMIT");
  assert.equal(calls[5].sql, "RELEASE");
  assert.deepEqual(queued, { id: 31 });
});

test("an older recovered snapshot is not inserted when a newer Telegram snapshot already exists", async (t) => {
  const originalConnect = pool.connect;
  t.after(() => {
    pool.connect = originalConnect;
  });

  const calls = [];
  const client = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (/INSERT INTO telegram_summary_alerts/.test(sql)) {
        return { rows: [] };
      }
      return { rows: [] };
    },
    release: () => calls.push({ sql: "RELEASE" }),
  };
  pool.connect = async () => client;

  const queued = await telegramAlertRepo.queueSummary({
    leadId: 7,
    throughMessageId: 40,
    score: { alertType: "ai_scoring_failed", summaryUnavailable: true },
  });

  assert.equal(queued, null);
  assert.match(calls[2].sql, /through_message_id < \$2/);
  assert.match(calls[3].sql, /WHERE NOT EXISTS/);
  assert.match(calls[3].sql, /newer\.through_message_id > \$2/);
});

test("next Telegram retry time follows the persisted 1-minute and 5-minute backoff", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql) => {
    assert.match(sql, /SELECT MIN/);
    assert.match(sql, /WHEN 1 THEN interval '1 minute'/);
    assert.match(sql, /WHEN 2 THEN interval '5 minutes'/);
    assert.match(sql, /status = 'pending'/);
    assert.match(sql, /attempts > 0/);
    assert.match(sql, /attempts < 3/);
    return { rows: [{ next_retry_at: "2026-10-07T00:01:00.000Z" }] };
  };

  assert.equal(
    await telegramAlertRepo.findNextRetryAt(),
    "2026-10-07T00:01:00.000Z"
  );
  assert.deepEqual(telegramAlertRepo.RETRY_DELAY_MINUTES, [1, 5]);
});

test("failed Telegram sends become terminal after the final attempt", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /CASE WHEN attempts >= 3 THEN 'failed' ELSE 'pending' END/);
    assert.match(sql, /claimed_at = NULL/);
    assert.deepEqual(params, [31, "Telegram unavailable"]);
    return { rows: [{ id: 31, status: "failed", attempts: 3 }] };
  };

  const result = await telegramAlertRepo.markFailed(31, new Error("Telegram unavailable"));
  assert.deepEqual(result, { id: 31, status: "failed", attempts: 3 });
});
