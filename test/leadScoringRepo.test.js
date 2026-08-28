const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const realtimeEvents = require("../src/utils/realtimeEvents");
const leadScoringRepo = require("../src/db/leadScoringRepo");

test("candidate query applies activation, three limits, and completed-pass boundary", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });
  let captured = null;
  pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };

  await leadScoringRepo.findCandidates({
    inactivityMinutes: 10,
    maxConversationMinutes: 60,
    maxMessages: 40,
    activatedAt: "2026-08-28T00:00:00.000Z",
    limit: 5,
  });

  assert.match(captured.sql, /s\.status = 'completed'/);
  assert.match(captured.sql, /m\.created_at >= \$4::timestamptz/);
  assert.match(captured.sql, /m\.id >= COALESCE\(l\.started_message_id, 0\)/);
  assert.match(captured.sql, /segment\.message_count >= \$3/);
  assert.match(captured.sql, /segment\.started_at <= now\(\) - \(\$2::integer/);
  assert.match(captured.sql, /latest\.created_at <= now\(\) - \(\$1::integer/);
  assert.match(captured.sql, /existing\.attempts >= 3/);
  assert.deepEqual(captured.params, [10, 60, 40, "2026-08-28T00:00:00.000Z", 5]);
});

test("transcript is limited to the current lead journey", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });
  let captured = null;
  pool.query = async (sql, params) => {
    captured = { sql, params };
    return {
      rows: [
        { id: 55, role: "user", content: "Newest" },
        { id: 42, role: "assistant", content: "Journey start" },
      ],
    };
  };

  const transcript = await leadScoringRepo.getTranscript(14, 42, 55, 80);

  assert.match(captured.sql, /id >= COALESCE\(\$2::integer, 0\)/);
  assert.match(captured.sql, /id <= \$3/);
  assert.deepEqual(captured.params, [14, 42, 55, 80]);
  assert.deepEqual(transcript.map((message) => message.id), [42, 55]);
});

test("claim is atomic, idempotent, and checks the latest message again", async (t) => {
  const originalQuery = pool.query;
  t.after(() => {
    pool.query = originalQuery;
  });
  let captured = null;
  pool.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [{ id: 101, attempts: 1 }] };
  };

  const claim = await leadScoringRepo.claimCandidate({
    lead_id: 8,
    contact_id: 14,
    through_message_id: 55,
    trigger_type: "message_ceiling",
  });

  assert.equal(claim.id, 101);
  assert.match(captured.sql, /ON CONFLICT \(lead_id, through_message_id\) DO UPDATE/);
  assert.match(captured.sql, /ORDER BY m\.id DESC LIMIT 1/);
  assert.match(captured.sql, /lead_temperature_scores\.attempts \+ 1/);
  assert.deepEqual(captured.params, [8, 55, "message_ceiling", 14]);
});

test("a new message supersedes an in-flight result without changing the lead", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });
  const queries = [];
  pool.connect = async () => ({
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT id, status FROM lead_temperature_scores/.test(sql)) {
        return { rows: [{ id: 110, status: "processing" }] };
      }
      if (/SELECT l\.\*/.test(sql)) {
        return { rows: [{ id: 8, latest_message_id: 56, is_closed: false }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  realtimeEvents.publish = () => assert.fail("superseded scores should not publish");

  const result = await leadScoringRepo.completeScore({
    scoreId: 110,
    leadId: 8,
    throughMessageId: 55,
    triggerType: "inactivity",
    score: {
      temperature: "hot",
      confidence: "high",
      reason: "Booking request",
      evidenceMessageIds: [55],
      provider: "gemini",
      model: "test",
      promptVersion: "v1",
    },
  });

  assert.equal(result.status, "superseded");
  assert.ok(queries.some(({ sql }) => /SET status = 'superseded'/.test(sql)));
  assert.equal(queries.some(({ sql }) => /UPDATE leads/.test(sql)), false);
  assert.equal(queries.some(({ sql }) => /INSERT INTO lead_activities/.test(sql)), false);
});

test("a high-confidence score updates only an unlocked lead and writes an audit activity", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });
  const queries = [];
  pool.connect = async () => ({
    query: async (sql, params) => {
      queries.push({ sql, params });
      if (/SELECT id, status FROM lead_temperature_scores/.test(sql)) {
        return { rows: [{ id: 111, status: "processing" }] };
      }
      if (/SELECT l\.\*/.test(sql)) {
        return { rows: [{ id: 8, latest_message_id: 55, is_closed: false, temperature: "warm", temperature_locked: false }] };
      }
      if (/UPDATE leads/.test(sql)) {
        return { rows: [{ id: 8, temperature: "hot", temperature_source: "ai" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  const published = [];
  realtimeEvents.publish = (event, payload) => published.push({ event, payload });

  const result = await leadScoringRepo.completeScore({
    scoreId: 111,
    leadId: 8,
    throughMessageId: 55,
    triggerType: "time_ceiling",
    score: {
      temperature: "hot",
      confidence: "high",
      reason: "The customer accepted tomorrow.",
      evidenceMessageIds: [55],
      provider: "gemini",
      model: "test",
      promptVersion: "v1",
    },
  });

  assert.equal(result.applied, true);
  const update = queries.find(({ sql }) => /UPDATE leads/.test(sql));
  assert.match(update.sql, /temperature_locked = false/);
  assert.match(update.sql, /temperature_source = 'ai'/);
  assert.doesNotMatch(update.sql, /stage_id/);
  const activity = queries.find(({ sql }) => /INSERT INTO lead_activities/.test(sql));
  assert.match(activity.sql, /'AI scoring'/);
  assert.equal(activity.params[2].applied, true);
  assert.deepEqual(published, [{ event: "pipeline_changed", payload: { leadId: 8 } }]);
});
