const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const { CONVERSATION_LOCK_NAMESPACE } = require("../src/db/conversationLock");
const followUpRepo = require("../src/db/followUpRepo");

test("automated follow-up inserts take the conversation scoring lock and re-check staff attention", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`));
    assert.match(sql, /FROM messages, conversation_lock/);
    assert.match(sql, /c\.needs_attention = false/);
    assert.deepEqual(params, [
      7,
      55,
      "Still interested?",
      "",
      1,
      null,
      120,
      "all",
      "2026-08-28T00:00:00.000Z",
    ]);
    assert.match(sql, /automated_follow_up_step/);
    assert.match(sql, /automated_follow_up_target_service/);
    assert.match(sql, /automated_follow_up_targeting_recorded/);
    assert.match(sql, /latest_lead\.is_closed = false/);
    assert.match(sql, /appointment_set.*visited/);
    assert.match(sql, /appointment_status.*set.*visited/);
    assert.match(sql, /appointment_status.*reschedule.*cancelled/);
    assert.match(sql, /COALESCE\(progress\.max_step, 0\) \+ 1 = \$5/);
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

test("automated follow-up discovery excludes conversations already waiting for staff", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /FROM contacts c/);
    assert.match(sql, /c\.needs_attention = false/);
    assert.match(sql, /previous_outbound/);
    assert.match(sql, /recent_inbound\.id <= latest_inbound\.id/);
    assert.match(sql, /recent_inbound\.id > previous_outbound\.id/);
    assert.match(sql, /latest_lead\.is_closed = false/);
    assert.match(sql, /appointment_set.*visited/);
    assert.match(sql, /appointment_status.*set.*visited/);
    assert.match(sql, /appointment_status.*reschedule.*cancelled/);
    assert.deepEqual(params, [
      [120],
      "all",
      "2026-08-28T00:00:00.000Z",
      25,
    ]);
    return { rows: [] };
  };

  const candidates = await followUpRepo.findCandidates({
    delayMinutes: 120,
    triggerMode: "all",
    activatedAt: "2026-08-28T00:00:00.000Z",
    limit: 25,
  });

  assert.deepEqual(candidates, []);
});


test("next follow-up due calculation excludes booked visited and closed latest leads", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  let capturedSql = "";
  pool.query = async (sql) => {
    capturedSql = sql;
    return { rows: [{ due_at: null }] };
  };

  await followUpRepo.getNextCandidateDueAt({
    delayMinutes: [120, 480],
    triggerMode: "all",
    activatedAt: "2026-08-28T00:00:00.000Z",
  });

  assert.match(capturedSql, /latest_lead\.is_closed = false/);
  assert.match(capturedSql, /COALESCE\(latest_lead\.stage_type, 'open'\) = 'open'/);
  assert.match(capturedSql, /appointment_set.*visited/);
  assert.match(capturedSql, /appointment_status.*set.*visited/);
  assert.match(capturedSql, /appointment_status.*reschedule.*cancelled/);
});
