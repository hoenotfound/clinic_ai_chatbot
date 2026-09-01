const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const followUpRepo = require("../src/db/followUpRepo");

const originalQuery = pool.query;

test.after(() => {
  pool.query = originalQuery;
});

test("candidate discovery covers all supported messaging channels inside the safety window", async () => {
  let capturedSql = null;
  let capturedParams = null;

  pool.query = async (sql, params) => {
    capturedSql = sql;
    capturedParams = params;
    return { rows: [] };
  };

  await followUpRepo.findCandidates({
    delayMinutes: 120,
    triggerMode: "all",
    activatedAt: "2026-08-28T00:00:00.000Z",
    limit: 25,
  });

  assert.match(capturedSql, /c\.channel IN \('whatsapp', 'facebook', 'instagram'\)/);
  assert.match(capturedSql, /c\.channel_user_id/);
  assert.match(capturedSql, /23 hours 50 minutes/);
  assert.match(capturedSql, /latest\.is_automated_follow_up = false/);
  assert.match(capturedSql, /automated_follow_up_for_message_id = latest\.id/);
  assert.deepEqual(capturedParams, [
    120,
    "all",
    "2026-08-28T00:00:00.000Z",
    25,
  ]);
});

test("atomic follow-up claim rechecks that the contact still has a valid recipient for its channel", async () => {
  let capturedSql = null;

  pool.query = async (sql) => {
    capturedSql = sql;
    return { rows: [] };
  };

  await followUpRepo.saveIfStillEligible({
    contactId: 7,
    triggerMessageId: 55,
    content: "Still interested?",
    mediaUrl: "",
    delayMinutes: 120,
    triggerMode: "all",
    activatedAt: "2026-08-28T00:00:00.000Z",
  });

  assert.match(capturedSql, /FROM latest, latest_inbound, contacts c/);
  assert.match(capturedSql, /c\.id = \$1/);
  assert.match(capturedSql, /c\.channel IN \('whatsapp', 'facebook', 'instagram'\)/);
  assert.match(capturedSql, /c\.channel IN \('facebook', 'instagram'\) AND c\.channel_user_id IS NOT NULL/);
  assert.match(capturedSql, /pg_advisory_xact_lock/);
  assert.match(capturedSql, /ON CONFLICT DO NOTHING/);
});

test("stale claim recovery is channel-neutral and never blindly resends", async () => {
  let capturedSql = null;

  pool.query = async (sql) => {
    capturedSql = sql;
    return { rows: [] };
  };

  await followUpRepo.markStaleClaimsUnconfirmed({
    olderThanMinutes: 10,
    limit: 25,
  });

  assert.match(capturedSql, /delivery_status = 'unknown'/);
  assert.match(capturedSql, /Check the customer chat before retrying to avoid sending it twice/);
  assert.match(capturedSql, /whatsapp_message_id IS NULL/);
  assert.match(capturedSql, /delivery_status IS NULL/);
  assert.doesNotMatch(capturedSql, /Check the WhatsApp chat/);
});
