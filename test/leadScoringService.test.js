const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createLeadScoringRunner,
  trimTranscript,
} = require("../src/services/leadScoringService");

const settings = {
  inactivityMinutes: 10,
  maxConversationMinutes: 60,
  maxMessages: 40,
  activatedAt: "2026-08-28T00:00:00.000Z",
};

function candidate() {
  return {
    lead_id: 7,
    contact_id: 12,
    started_message_id: 33,
    through_message_id: 44,
    trigger_type: "inactivity",
    temperature: "warm",
  };
}

test("does not query leads while AI scoring is disabled", async () => {
  let queries = 0;
  const run = createLeadScoringRunner({
    settingsGetter: () => null,
    repository: {
      findCandidates: async () => {
        queries += 1;
        return [];
      },
    },
  });

  await run();
  assert.equal(queries, 0);
});

test("claims, scores, and completes an eligible conversation snapshot", async () => {
  const calls = [];
  let transcriptArgs = null;
  const score = {
    temperature: "hot",
    confidence: "high",
    reason: "The customer asked for a booking tomorrow.",
    evidenceMessageIds: [44],
    provider: "gemini",
    model: "test-model",
    promptVersion: "test-v1",
  };
  const lead = candidate();
  const run = createLeadScoringRunner({
    settingsGetter: () => settings,
    repository: {
      findCandidates: async (input) => {
        calls.push(["find", input]);
        return [lead];
      },
      claimCandidate: async (input) => {
        calls.push(["claim", input]);
        return { id: 91 };
      },
      getTranscript: async (...args) => {
        transcriptArgs = args;
        return [
          { id: 43, role: "assistant", content: "Would tomorrow suit you?" },
          { id: 44, role: "user", content: "Yes, please book me." },
        ];
      },
      completeScore: async (input) => calls.push(["complete", input]),
      markScoreCancelled: async () => assert.fail("score should not be cancelled"),
      markScoreFailed: async () => assert.fail("score should not fail"),
    },
    scoreConversation: async ({ messages, lead: scoringLead }) => {
      assert.equal(messages.length, 2);
      assert.equal(scoringLead.lead_id, 7);
      return score;
    },
  });

  await run();

  assert.equal(calls[0][0], "find");
  assert.equal(calls[0][1].limit, 5);
  assert.equal(calls[1][0], "claim");
  assert.deepEqual(transcriptArgs, [12, 33, 44, 80]);
  assert.deepEqual(calls[2], ["complete", {
    scoreId: 91,
    leadId: 7,
    throughMessageId: 44,
    triggerType: "inactivity",
    score,
  }]);
});

test("cancels a completed AI call when staff pauses the tool", async () => {
  let liveSettings = settings;
  let cancelledId = null;
  let completed = false;
  const run = createLeadScoringRunner({
    settingsGetter: () => liveSettings,
    repository: {
      findCandidates: async () => [candidate()],
      claimCandidate: async () => ({ id: 92 }),
      getTranscript: async () => [{ id: 44, role: "user", content: "Book me" }],
      markScoreCancelled: async (id) => {
        cancelledId = id;
      },
      markScoreFailed: async () => assert.fail("score should not fail"),
      completeScore: async () => {
        completed = true;
      },
    },
    scoreConversation: async () => {
      liveSettings = null;
      return {
        temperature: "hot",
        confidence: "high",
        reason: "Booking request",
        evidenceMessageIds: [44],
      };
    },
  });

  await run();
  assert.equal(cancelledId, 92);
  assert.equal(completed, false);
});

test("records a failed scoring attempt without stopping the sweep", async (t) => {
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = () => {};
  let failure = null;
  const run = createLeadScoringRunner({
    settingsGetter: () => settings,
    repository: {
      findCandidates: async () => [candidate()],
      claimCandidate: async () => ({ id: 93 }),
      getTranscript: async () => [{ id: 44, role: "user", content: "Hello" }],
      markScoreFailed: async (id, error) => {
        failure = { id, error };
      },
    },
    scoreConversation: async () => {
      throw new Error("provider unavailable");
    },
  });

  await run();
  assert.equal(failure.id, 93);
  assert.match(failure.error.message, /provider unavailable/);
});

test("long transcripts keep the newest complete messages", () => {
  const messages = [
    { id: 1, content: "a".repeat(20_000) },
    { id: 2, content: "b".repeat(20_000) },
    { id: 3, content: "latest" },
  ];
  assert.deepEqual(trimTranscript(messages).map((message) => message.id), [2, 3]);
});
