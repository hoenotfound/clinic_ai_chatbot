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

test("optional startup delay waits for the initial grace period but accepts an earlier wake", async () => {
  const timers = fakeTimers();
  let runs = 0;
  const worker = createAdaptiveWorkerTimer({
    run: async () => { runs++; return null; },
    delayForResult: () => null,
    ...timers,
  });
  worker.start(600000);
  await timers.advance(0);
  assert.equal(runs, 0);
  await timers.advance(1000);
  assert.equal(runs, 0);
  worker.wake(1000);
  await timers.advance(1000);
  assert.equal(runs, 1);
  worker.stop();
});

test("event during a run must not postpone an earlier computed due time", async () => {
  const timers = fakeTimers();
  let release;
  let runs = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const worker = createAdaptiveWorkerTimer({
    run: async () => {
      runs++;
      if (runs === 1) await gate;
      return runs === 1 ? { nextMs: 60 * 1000 } : { nextMs: null };
    },
    delayForResult: result => result.nextMs,
    ...timers,
  });
  worker.start();
  const advancing = timers.advance(0);
  await Promise.resolve();
  worker.wake(5 * 60 * 1000); // chat event while a due slot is discovered
  release();
  await advancing;
  assert.equal(worker.state().dueAt, 60 * 1000,
    "earlier 1-minute template deadline must beat 5-minute event wake");
  await timers.advance(60 * 1000);
  assert.equal(runs, 2);
  worker.stop();
});

test("pending immediate wakes win over later computed deadlines", async () => {
  const timers = fakeTimers();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let runs = 0;
  const worker = createAdaptiveWorkerTimer({
    run: async () => {
      runs++;
      if (runs === 1) await gate;
      return 15 * 60 * 1000;
    },
    delayForResult: value => value,
    ...timers,
  });
  worker.start();
  const advancing = timers.advance(0);
  await Promise.resolve();
  worker.wake(0);
  release();
  await advancing;
  assert.equal(runs, 2,
    "the immediate event must trigger the second run before the clock advances");
  assert.equal(worker.state().dueAt, 15 * 60 * 1000,
    "after the immediate run, the worker may schedule its next idle interval");
  worker.stop();
});

test("null result still accepts event wake and error retry is not delayed", async () => {
  const timers = fakeTimers();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let runs = 0;
  const worker = createAdaptiveWorkerTimer({
    run: async () => {
      runs++;
      if (runs === 1) await gate;
      if (runs === 1) throw new Error("transient");
      return null;
    },
    logger: {error() {}},
    errorRetryDelayMs: 10 * 1000,
    delayForResult: () => null,
    ...timers,
  });
  worker.start();
  const advancing = timers.advance(0);
  await Promise.resolve();
  worker.wake(5 * 60 * 1000);
  release();
  await advancing;
  assert.equal(worker.state().dueAt, 10 * 1000);
  await timers.advance(10 * 1000);
  assert.equal(runs, 2);
  worker.stop();
});

test("delay callback failure retries safely instead of stranding the timer", async () => {
  const timers = fakeTimers();
  const errors = [];
  let count = 0;
  const worker = createAdaptiveWorkerTimer({
    run: async () => ++count,
    delayForResult: () => { throw new Error("invalid scheduling hint"); },
    logger: {error(...args) {errors.push(args);}},
    errorRetryDelayMs: 2000,
    ...timers,
  });
  worker.start();
  await timers.advance(0);
  assert.equal(count, 1);
  assert.equal(worker.state().dueAt, 2000);
  assert.equal(errors.length, 1);
  worker.stop();
});
