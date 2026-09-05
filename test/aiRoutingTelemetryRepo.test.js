const test = require("node:test");
const assert = require("node:assert/strict");

const {
  getRoutingSummary,
  recordRoutingEvent,
} = require("../src/db/aiRoutingTelemetryRepo");

test("AI routing telemetry stores only the allowed high-level fields", async () => {
  const calls = [];
  const queryable = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const at = new Date("2026-09-05T00:00:00.000Z");

  await recordRoutingEvent({
    eventType: "gemini_model_fallback",
    provider: "gemini",
    model: "gemini-2.5-flash-lite",
    at,
  }, queryable);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INSERT INTO ai_routing_events/);
  assert.deepEqual(calls[0].params, [
    "gemini_model_fallback",
    "gemini",
    "gemini-2.5-flash-lite",
    at,
  ]);
  assert.doesNotMatch(calls[0].sql, /api_key|prompt|response|contact_id/i);
});

test("invalid routing event types are ignored", async () => {
  let calls = 0;
  const queryable = { async query() { calls += 1; return { rows: [] }; } };
  await recordRoutingEvent({ eventType: "raw_provider_payload" }, queryable);
  assert.equal(calls, 0);
});

test("AI routing summary maps the 24-hour fallback and final-failure totals", async () => {
  const queryable = {
    async query(sql, params) {
      assert.match(sql, /gemini_model_fallback/);
      assert.match(sql, /claude_fallback/);
      assert.match(sql, /ai_failure/);
      assert.deepEqual(params, [24]);
      return {
        rows: [{
          gemini_model_fallbacks: 3,
          claude_fallbacks: 2,
          ai_failures: 1,
          last_ai_failure_at: new Date("2026-09-05T00:00:00.000Z"),
        }],
      };
    },
  };

  const summary = await getRoutingSummary({ hours: 24 }, queryable);
  assert.equal(summary.geminiModelFallbacks, 3);
  assert.equal(summary.claudeFallbacks, 2);
  assert.equal(summary.aiFailures, 1);
  assert.equal(summary.windowHours, 24);
});
