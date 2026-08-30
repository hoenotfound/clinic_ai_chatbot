const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLeadScoringRunner,
} = require("../src/services/leadScoringService");

const settings = {
  inactivityMinutes: 10,
  maxConversationMinutes: 60,
  maxMessages: 40,
  activatedAt: "2026-08-28T00:00:00.000Z",
};

test("stale final-attempt recovery runs before terminal failures are queued to Telegram", async () => {
  const order = [];
  const queued = [];

  const run = createLeadScoringRunner({
    settingsGetter: () => settings,
    repository: {
      findCandidates: async () => [],
      findTerminalFailuresNeedingAlert: async () => {
        order.push("find-terminal");
        return [
          {
            lead_id: 8,
            through_message_id: 55,
            attempts: 3,
          },
        ];
      },
    },
    recoverStaleTerminalFailures: async () => {
      order.push("recover-processing");
      return [
        {
          id: 120,
          lead_id: 8,
          through_message_id: 55,
          attempts: 3,
        },
      ];
    },
    queueConversationSummary: async (input) => {
      order.push("queue-fallback");
      queued.push(input);
      return { status: "queued", alertId: 42 };
    },
    flushConversationSummaries: async () => {
      order.push("flush");
      return { status: "completed", sent: 1 };
    },
  });

  await run();

  assert.deepEqual(order, [
    "recover-processing",
    "find-terminal",
    "queue-fallback",
    "flush",
  ]);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].leadId, 8);
  assert.equal(queued[0].throughMessageId, 55);
  assert.equal(queued[0].score.summaryUnavailable, true);
});
