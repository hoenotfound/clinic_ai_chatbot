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

function candidate(overrides = {}) {
  return {
    lead_id: 7,
    contact_id: 12,
    started_message_id: 33,
    journey_started_at: "2026-08-28T00:05:00.000Z",
    through_message_id: 44,
    trigger_type: "inactivity",
    temperature: "warm",
    ...overrides,
  };
}

function scoredLead() {
  return {
    temperature: "hot",
    confidence: "high",
    reason: "The customer asked for a booking tomorrow.",
    evidenceMessageIds: [44],
    summary: {
      treatmentInterest: "HIFU",
      preferredBranch: "Puchong",
      preferredAppointment: "tomorrow",
      mainConcern: "Jawline lifting",
      chatSummary: "Customer asked about HIFU and requested a booking tomorrow.",
      nextAction: "Confirm an available appointment time.",
    },
    provider: "gemini",
    model: "test-model",
    promptVersion: "test-v2",
  };
}

function completedRepository(lead, calls = []) {
  return {
    findCandidates: async (input) => {
      calls.push(["find", input]);
      return [lead];
    },
    claimCandidate: async (input) => {
      calls.push(["claim", input]);
      return { id: 91 };
    },
    getTranscript: async (...args) => {
      calls.push(["transcript", args]);
      return [
        { id: 43, role: "assistant", content: "Would tomorrow suit you?" },
        { id: 44, role: "user", content: "Yes, please book me." },
      ];
    },
    completeScore: async (input) => {
      calls.push(["complete", input]);
      return { status: "completed" };
    },
    markScoreCancelled: async () => assert.fail("score should not be cancelled"),
    markScoreFailed: async () => assert.fail("score should not fail"),
  };
}

test("does not query leads while AI scoring is disabled", async () => {
  let queries = 0;
  let flushes = 0;
  const run = createLeadScoringRunner({
    settingsGetter: () => null,
    repository: {
      findCandidates: async () => {
        queries += 1;
        return [];
      },
    },
    flushConversationSummaries: async () => {
      flushes += 1;
    },
  });

  await run();
  assert.equal(queries, 0);
  assert.equal(flushes, 0);
});

test("completed score queues its exact snapshot and then runs the inactivity flush", async () => {
  const calls = [];
  let queued = null;
  let flushed = null;
  const score = scoredLead();
  const lead = candidate();
  const run = createLeadScoringRunner({
    settingsGetter: () => settings,
    repository: completedRepository(lead, calls),
    scoreConversation: async ({ messages, lead: scoringLead }) => {
      assert.equal(messages.length, 2);
      assert.equal(scoringLead.lead_id, 7);
      return score;
    },
    queueConversationSummary: async (input) => {
      queued = input;
      return { status: "queued" };
    },
    flushConversationSummaries: async (input) => {
      flushed = input;
      return { status: "completed", sent: 1 };
    },
  });

  await run();

  assert.equal(calls[0][0], "find");
  assert.equal(calls[0][1].limit, 5);
  assert.deepEqual(calls[2][1], [
    12,
    33,
    "2026-08-28T00:05:00.000Z",
    44,
    80,
  ]);
  assert.deepEqual(queued, {
    leadId: 7,
    throughMessageId: 44,
    score,
  });
  assert.deepEqual(flushed, { inactivityMinutes: 10 });
});

test("time and message ceiling scores are queued so they can wait for later inactivity", async () => {
  for (const triggerType of ["time_ceiling", "message_ceiling"]) {
    let queued = null;
    let flushes = 0;
    const lead = candidate({ trigger_type: triggerType });
    const run = createLeadScoringRunner({
      settingsGetter: () => settings,
      repository: completedRepository(lead),
      scoreConversation: async () => scoredLead(),
      queueConversationSummary: async (input) => {
        queued = input;
      },
      flushConversationSummaries: async () => {
        flushes += 1;
      },
    });

    await run();
    assert.equal(queued.leadId, 7);
    assert.equal(queued.throughMessageId, 44);
    assert.equal(flushes, 1);
  }
});

test("superseded scoring result is not queued but pending summaries still get flushed", async () => {
  let queueCalls = 0;
  let flushCalls = 0;
  const run = createLeadScoringRunner({
    settingsGetter: () => settings,
    repository: {
      findCandidates: async () => [candidate()],
      claimCandidate: async () => ({ id: 95 }),
      getTranscript: async () => [{ id: 44, role: "user", content: "Book me" }],
      completeScore: async () => ({ status: "superseded" }),
      markScoreCancelled: async () => assert.fail("score should not be cancelled"),
      markScoreFailed: async () => assert.fail("score should not fail"),
    },
    scoreConversation: async () => scoredLead(),
    queueConversationSummary: async () => {
      queueCalls += 1;
    },
    flushConversationSummaries: async () => {
      flushCalls += 1;
    },
  });

  await run();
  assert.equal(queueCalls, 0);
  assert.equal(flushCalls, 1);
});

test("Telegram queue and flush failures do not convert a completed score into a failed score", async (t) => {
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = () => {};

  let failedScoreCalls = 0;
  const run = createLeadScoringRunner({
    settingsGetter: () => settings,
    repository: {
      ...completedRepository(candidate()),
      markScoreFailed: async () => {
        failedScoreCalls += 1;
      },
    },
    scoreConversation: async () => scoredLead(),
    queueConversationSummary: async () => {
      throw new Error("queue unavailable");
    },
    flushConversationSummaries: async () => {
      throw new Error("Telegram unavailable");
    },
  });

  await run();
  assert.equal(failedScoreCalls, 0);
});

test("cancels a completed AI call when staff pauses the tool", async () => {
  let liveSettings = settings;
  let cancelledId = null;
  let completed = false;
  let flushed = false;
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
      return scoredLead();
    },
    flushConversationSummaries: async () => {
      flushed = true;
    },
  });

  await run();
  assert.equal(cancelledId, 92);
  assert.equal(completed, false);
  assert.equal(flushed, false);
});

test("records a failed scoring attempt without stopping the sweep", async (t) => {
  const originalError = console.error;
  t.after(() => {
    console.error = originalError;
  });
  console.error = () => {};
  let failure = null;
  let flushed = false;
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
    flushConversationSummaries: async () => {
      flushed = true;
    },
  });

  await run();
  assert.equal(failure.id, 93);
  assert.match(failure.error.message, /provider unavailable/);
  assert.equal(flushed, true);
});

test("long transcripts keep the newest complete messages", () => {
  const messages = [
    { id: 1, content: "a".repeat(20_000) },
    { id: 2, content: "b".repeat(20_000) },
    { id: 3, content: "latest" },
  ];
  assert.deepEqual(trimTranscript(messages).map((message) => message.id), [2, 3]);
});
