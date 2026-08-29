const test = require("node:test");
const assert = require("node:assert/strict");

const { pool } = require("../src/db/db");
const realtimeEvents = require("../src/utils/realtimeEvents");
const leadScoringRepo = require("../src/db/leadScoringRepo");

const summary = {
  treatmentInterest: "HIFU",
  preferredBranch: "Puchong",
  preferredAppointment: "Tomorrow at 12pm",
  mainConcern: "Face lifting",
  chatSummary: "Customer wants HIFU and proposed tomorrow at noon.",
  nextAction: "Confirm the appointment slot.",
};

function score() {
  return {
    temperature: "hot",
    confidence: "high",
    reason: "Customer proposed a concrete appointment time.",
    evidenceMessageIds: [55],
    summary,
    provider: "gemini",
    model: "test-model",
    promptVersion: "lead-temperature-v2",
  };
}

test("completed scores persist the structured summary and include it in audit metadata", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  const queries = [];
  pool.connect = async () => ({
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/FROM lead_temperature_scores s/.test(sql)) {
        return { rows: [{ id: 111, status: "processing", contact_id: 14 }] };
      }
      if (/SELECT l\.\*/.test(sql)) {
        return {
          rows: [{
            id: 8,
            latest_message_id: 55,
            is_closed: false,
            temperature: "warm",
            temperature_locked: false,
          }],
        };
      }
      if (/UPDATE leads/.test(sql)) {
        return { rows: [{ id: 8, temperature: "hot", temperature_source: "ai" }] };
      }
      return { rows: [] };
    },
    release: () => {},
  });
  realtimeEvents.publish = () => {};

  const result = await leadScoringRepo.completeScore({
    scoreId: 111,
    leadId: 8,
    throughMessageId: 55,
    triggerType: "inactivity",
    score: score(),
  });

  assert.equal(result.status, "completed");
  const scoreUpdate = queries.find(({ sql }) => /SET status = 'completed'/.test(sql));
  assert.ok(scoreUpdate);
  assert.match(scoreUpdate.sql, /summary_data = \$6::jsonb/);
  assert.equal(scoreUpdate.params[4], "[55]");
  assert.equal(scoreUpdate.params[5], JSON.stringify(summary));
  assert.equal(scoreUpdate.params[9], true);

  const activity = queries.find(({ sql }) => /INSERT INTO lead_activities/.test(sql));
  assert.deepEqual(activity.params[2].summary, summary);
});

test("superseded scores keep their structured summary for audit without applying it", async (t) => {
  const originalConnect = pool.connect;
  const originalPublish = realtimeEvents.publish;
  t.after(() => {
    pool.connect = originalConnect;
    realtimeEvents.publish = originalPublish;
  });

  const queries = [];
  pool.connect = async () => ({
    query: async (sql, params = []) => {
      queries.push({ sql, params });
      if (/FROM lead_temperature_scores s/.test(sql)) {
        return { rows: [{ id: 110, status: "processing", contact_id: 14 }] };
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
    score: score(),
  });

  assert.equal(result.status, "superseded");
  const scoreUpdate = queries.find(({ sql }) => /SET status = 'superseded'/.test(sql));
  assert.ok(scoreUpdate);
  assert.match(scoreUpdate.sql, /summary_data = \$6::jsonb/);
  assert.equal(scoreUpdate.params[5], JSON.stringify(summary));
  assert.equal(queries.some(({ sql }) => /INSERT INTO lead_activities/.test(sql)), false);
});
