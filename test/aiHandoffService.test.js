const test = require("node:test");
const assert = require("node:assert/strict");

const {
  AI_HANDOFF_OWNER,
  createAiHandoffService,
} = require("../src/services/aiHandoffService");

test("AI handoff atomically pauses AI, keeps Needs Attention, and alerts staff", async () => {
  const calls = [];
  const published = [];
  const alerts = [];
  const pause = createAiHandoffService({
    database: {
      async query(sql, params) {
        calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
        return {
          rows: [{
            id: 42,
            mode: "human",
            takeover_by: AI_HANDOFF_OWNER,
            needs_attention: true,
            attention_reason: "AI handed off this conversation.",
            attention_message_id: 777,
          }],
        };
      },
    },
    publish(type, payload) {
      published.push({ type, payload });
    },
    sendHumanInterventionAlert(input) {
      alerts.push(input);
      return { status: "sent" };
    },
  });

  const result = await pause(42);
  assert.equal(result.mode, "human");
  assert.equal(result.needs_attention, true);
  assert.match(calls[0].sql, /mode = 'human'/);
  assert.match(calls[0].sql, /needs_attention = true/);
  assert.match(calls[0].sql, /AND c\.mode = 'ai'/);
  assert.equal(calls[0].params[0], AI_HANDOFF_OWNER);
  assert.deepEqual(published, [{
    type: "conversation_changed",
    payload: { contactId: 42, reason: "ai_handoff" },
  }]);
  assert.deepEqual(alerts, [{
    contactId: 42,
    messageId: 777,
    reason: "AI handed off this conversation.",
  }]);
});

test("AI handoff is a no-op if staff already took ownership", async () => {
  let alerted = false;
  const pause = createAiHandoffService({
    database: { async query() { return { rows: [] }; } },
    publish() { throw new Error("should not publish"); },
    sendHumanInterventionAlert() { alerted = true; },
  });

  assert.equal(await pause(42), null);
  assert.equal(alerted, false);
});
