const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { pool } = require("../src/db/db");
const { CONVERSATION_LOCK_NAMESPACE } = require("../src/db/conversationLock");
const followUpRepo = require("../src/db/followUpRepo");

test("AI generation lease also blocks an AI anchor that predates real staff takeover", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src/db/followUpAiLeaseRepo.js"),
    "utf8"
  );

  assert.match(source, /c\.takeover_at IS NOT NULL/);
  assert.match(source, /anchor\.sent_by_username IS NULL/);
  assert.match(source, /anchor\.created_at < c\.takeover_at/);
});

test("automated follow-up inserts take the conversation scoring lock and re-check staff attention", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`));
    assert.match(sql, /FROM messages inbound, conversation_lock/);
    assert.match(sql, /FROM messages outbound, latest_inbound/);
    assert.match(sql, /c\.needs_attention = false/);
    assert.match(sql, /anchor\.created_at < c\.takeover_at/);
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
      0,
      "fixed",
    ]);
    assert.match(sql, /automated_follow_up_step/);
    assert.match(sql, /automated_follow_up_target_service/);
    assert.match(sql, /automated_follow_up_targeting_recorded/);
    assert.match(sql, /automated_follow_up_message_mode/);
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

test("later follow-up claims preserve spacing from the actual previous send", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /previous_follow_up AS/);
    assert.match(sql, /automated_follow_up_step = \$5 - 1/);
    assert.match(
      sql,
      /previous_follow_up\.created_at \+ \(\(\$7::integer - \$10::integer\) \* interval '1 minute'\)/
    );
    assert.match(sql, /GREATEST\(/);
    assert.deepEqual(params, [
      7,
      55,
      "Second follow-up",
      "",
      2,
      null,
      480,
      "all",
      "2026-08-28T00:00:00.000Z",
      120,
      "fixed",
    ]);
    return { rows: [] };
  };

  await followUpRepo.saveIfStillEligible({
    contactId: 7,
    triggerMessageId: 55,
    content: "Second follow-up",
    mediaUrl: "",
    stepIndex: 2,
    delayMinutes: 480,
    previousDelayMinutes: 120,
    triggerMode: "all",
    activatedAt: "2026-08-28T00:00:00.000Z",
  });
});

test("automated follow-up discovery excludes conversations already waiting for staff", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(sql, /FROM contacts c/);
    assert.match(sql, /c\.needs_attention = false/);
    assert.match(sql, /anchor\.sent_by_username IS NULL/);
    assert.match(sql, /anchor\.created_at < c\.takeover_at/);
    assert.match(sql, /previous_outbound/);
    assert.match(sql, /recent_inbound\.id <= latest_inbound\.id/);
    assert.match(sql, /recent_inbound\.id > previous_outbound\.id/);
    assert.match(sql, /latest_lead\.is_closed = false/);
    assert.match(sql, /appointment_set.*visited/);
    assert.match(sql, /appointment_status.*set.*visited/);
    assert.match(sql, /appointment_status.*reschedule.*cancelled/);
    assert.match(sql, /previous_follow_up_created_at/);
    assert.match(sql, /next_follow_up_step - 1/);
    assert.match(sql, /GREATEST\(/);
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
  assert.match(capturedSql, /previous_follow_up_created_at/);
  assert.match(capturedSql, /next_follow_up_step - 1/);
  assert.match(capturedSql, /GREATEST\(/);
});


test("final claim eligibility rechecks newer messages and lead completion under the conversation lock", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(
      sql,
      new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`)
    );
    assert.match(sql, /m\.automated_follow_up_for_message_id IS NOT NULL/);
    assert.match(sql, /JOIN messages anchor/);
    assert.match(sql, /anchor\.created_at < c\.takeover_at/);
    assert.match(sql, /newer\.role = 'user'/);
    assert.match(sql, /newer\.is_automated_follow_up = false/);
    assert.match(sql, /latest_lead\.is_closed = false/);
    assert.match(sql, /appointment_set.*visited/);
    assert.deepEqual(params, [22, 120]);
    return { rows: [{ eligible: true }] };
  };

  const eligible = await followUpRepo.isClaimStillEligible({
    contactId: 22,
    messageId: 120,
  });

  assert.equal(eligible, true);
});

test("discarding an unsent final claim only removes a still-unaccepted automated follow-up", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(
      sql,
      new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`)
    );
    assert.match(sql, /DELETE FROM messages/);
    assert.match(sql, /is_automated_follow_up = true/);
    assert.match(sql, /automated_follow_up_for_message_id IS NOT NULL/);
    assert.match(sql, /delivery_status IS NULL/);
    assert.match(sql, /whatsapp_message_id IS NULL/);
    assert.deepEqual(params, [22, 120]);
    return {
      rows: [
        {
          id: 120,
          contact_id: 22,
          delivery_status: null,
          whatsapp_message_id: null,
        },
      ],
    };
  };

  const discarded = await followUpRepo.discardUnsentClaim({
    contactId: 22,
    messageId: 120,
  });

  assert.equal(discarded.id, 120);
  assert.equal(discarded.contact_id, 22);
});


test("discarding an unsent social follow-up image only removes an unaccepted companion", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });

  pool.query = async (sql, params) => {
    assert.match(
      sql,
      new RegExp(`pg_advisory_xact_lock\\(${CONVERSATION_LOCK_NAMESPACE}`)
    );
    assert.match(sql, /DELETE FROM messages/);
    assert.match(sql, /automated_follow_up_for_message_id IS NULL/);
    assert.match(sql, /content = ''/);
    assert.match(sql, /media_url IS NOT NULL/);
    assert.match(sql, /delivery_status IS NULL/);
    assert.match(sql, /whatsapp_message_id IS NULL/);
    assert.deepEqual(params, [23, 130]);
    return {
      rows: [
        {
          id: 130,
          contact_id: 23,
          delivery_status: null,
          whatsapp_message_id: null,
        },
      ],
    };
  };

  const discarded = await followUpRepo.discardUnsentSocialImageCompanion({
    contactId: 23,
    messageId: 130,
  });

  assert.equal(discarded.id, 130);
  assert.equal(discarded.contact_id, 23);
});
