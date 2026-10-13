"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLeadScoringRunner,
  createPinnedWakeScheduler,
} = require("../src/services/leadScoringService");
const { createAdaptiveWorkerTimer } = require("../src/utils/adaptiveWorkerTimer");

function fakeClock() {
  let time = 0;
  let id = 0;
  const timers = new Map();
  function setTimeoutImpl(fn, delay) {
    const handle = { id: ++id, unref() {} };
    timers.set(handle.id, { fn, at: time + delay, handle });
    return handle;
  }
  function clearTimeoutImpl(handle) {
    if (handle) timers.delete(handle.id);
  }
  async function advance(ms) {
    time += ms;
    for (;;) {
      const due = [...timers.values()]
        .filter((timer) => timer.at <= time)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) return;
      timers.delete(due.handle.id);
      await due.fn();
    }
  }
  return { now: () => time, setTimeoutImpl, clearTimeoutImpl, advance, timers };
}

test("lead scoring retry deadline survives early unrelated activity wake", async () => {
  const clock = fakeClock();
  let worker;
  let failureAt = null;
  let completed = false;
  let scoreCalls = 0;
  let findCalls = 0;
  const pinned = createPinnedWakeScheduler({
    wake: () => worker.wake(0),
    ...clock,
  });
  const settings = {
    inactivityMinutes: 10, maxConversationMinutes: 60,
    maxMessages: 40, activatedAt: "2026-10-13T00:00:00Z",
  };
  const candidate = {
    lead_id: 7, contact_id: 12, started_message_id: 1,
    through_message_id: 44, journey_started_at: settings.activatedAt,
    trigger_type: "inactivity",
  };
  const runner = createLeadScoringRunner({
    settingsGetter: () => settings,
    repository: {
      findCandidates: async () => {
        findCalls += 1;
        if (completed || (failureAt !== null && clock.now() - failureAt < 120_000))
          return [];
        return [candidate];
      },
      claimCandidate: async () => ({ id: 91 }),
      getTranscript: async () => [{ id: 44, role: "user", content: "Can I book?" }],
      markScoreFailed: async () => {
        failureAt = clock.now();
        return { id: 91, terminal: false, attempts: 1 };
      },
      completeScore: async () => {
        completed = true;
        return { status: "completed" };
      },
    },
    scoreConversation: async () => {
      scoreCalls += 1;
      if (scoreCalls === 1) throw new Error("temporary AI failure");
      return {
        temperature: "warm", confidence: "medium", reason: "Interested in booking",
        evidenceMessageIds: [44], summary: {}, provider: "gemini",
        model: "test-model", promptVersion: "test",
      };
    },
    queueConversationSummary: async () => ({ status: "queued" }),
    flushConversationSummaries: async () => ({ status: "completed", sent: 0 }),
    scheduleWake: pinned.schedule,
    clock: clock.now,
  });
  worker = createAdaptiveWorkerTimer({
    run: runner, delayForResult: () => null, ...clock,
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    worker.start();
    await clock.advance(0);
    assert.equal(scoreCalls, 1);
    assert.equal(pinned.state().nextDueAt, 120_000);

    await clock.advance(30_000);
    worker.wake(0); // Another customer's message, before the retry is eligible.
    await clock.advance(0);
    assert.equal(scoreCalls, 1);
    assert.equal(findCalls, 2);
    assert.equal(worker.state().scheduled, false,
      "adaptive worker is idle, so its own timer cannot preserve the retry");
    assert.equal(pinned.state().nextDueAt, 120_000,
      "the independent retry deadline survives the early wake");

    await clock.advance(89_999);
    assert.equal(scoreCalls, 1);
    await clock.advance(1);
    assert.equal(scoreCalls, 2, "the original retry fires without another message");
    assert.equal(completed, true);
    assert.equal(pinned.state().pendingCount, 0);
  } finally {
    console.error = originalError;
    pinned.clear();
    worker.stop();
  }
});

test("pinned retry scheduler retains multiple independent deadlines and cleans up on stop", async () => {
  const clock = fakeClock();
  const wakeTimes = [];
  const pinned = createPinnedWakeScheduler({ wake: () => wakeTimes.push(clock.now()), ...clock });
  assert.equal(pinned.schedule(120_000), true);
  await clock.advance(10_000);
  assert.equal(pinned.schedule(240_000), true);
  assert.equal(pinned.schedule(240_000), false, "duplicate deadline is coalesced");
  assert.equal(pinned.state().pendingCount, 2);
  await clock.advance(110_000);
  assert.deepEqual(wakeTimes, [120_000]);
  assert.equal(pinned.state().nextDueAt, 250_000);
  await clock.advance(130_000);
  assert.deepEqual(wakeTimes, [120_000, 250_000]);
  assert.equal(pinned.state().pendingCount, 0);

  pinned.schedule(5_000);
  pinned.clear();
  await clock.advance(5_000);
  assert.deepEqual(wakeTimes, [120_000, 250_000], "stopped worker cannot wake");
  assert.equal(pinned.state().pendingCount, 0);
});
