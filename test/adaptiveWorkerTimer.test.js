const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdaptiveWorkerTimer } = require("../src/utils/adaptiveWorkerTimer");

function fakeTimers() {
  let clock = 0;
  let nextId = 1;
  const timers = new Map();

  function setTimeoutImpl(fn, delay) {
    const handle = {
      id: nextId++,
      unref() {},
    };
    timers.set(handle.id, { handle, fn, dueAt: clock + delay });
    return handle;
  }

  function clearTimeoutImpl(handle) {
    if (handle) timers.delete(handle.id);
  }

  async function advance(ms) {
    clock += ms;
    while (true) {
      const due = [...timers.values()]
        .filter((item) => item.dueAt <= clock)
        .sort((a, b) => a.dueAt - b.dueAt)[0];
      if (!due) break;
      timers.delete(due.handle.id);
      await due.fn();
    }
  }

  return {
    now: () => clock,
    setTimeoutImpl,
    clearTimeoutImpl,
    advance,
    timers,
  };
}

test("adaptive timer sleeps when delayForResult returns null", async () => {
  const timers = fakeTimers();
  let runs = 0;
  const worker = createAdaptiveWorkerTimer({
    run: async () => {
      runs += 1;
      return { work: false };
    },
    delayForResult: () => null,
    ...timers,
  });

  worker.start();
  await timers.advance(0);

  assert.equal(runs, 1);
  assert.equal(worker.state().scheduled, false);
});

test("wake schedules an idle worker and keeps an earlier wake", async () => {
  const timers = fakeTimers();
  let runs = 0;
  const worker = createAdaptiveWorkerTimer({
    run: async () => {
      runs += 1;
      return null;
    },
    delayForResult: () => null,
    ...timers,
  });

  worker.start();
  await timers.advance(0);
  worker.wake(1000);
  worker.wake(5000);

  await timers.advance(999);
  assert.equal(runs, 1);
  await timers.advance(1);
  assert.equal(runs, 2);
});

test("wake during a run causes another run without overlapping", async () => {
  const timers = fakeTimers();
  let release;
  let runs = 0;
  const firstRun = new Promise((resolve) => {
    release = resolve;
  });

  const worker = createAdaptiveWorkerTimer({
    run: async () => {
      runs += 1;
      if (runs === 1) await firstRun;
      return null;
    },
    delayForResult: () => null,
    ...timers,
  });

  worker.start();
  const advancing = timers.advance(0);
  await Promise.resolve();
  worker.wake(0);
  release();
  await advancing;
  await timers.advance(0);

  assert.equal(runs, 2);
});
