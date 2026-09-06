function normalizeDelay(delayMs) {
  if (delayMs === null || delayMs === undefined) return null;
  const value = Number(delayMs);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

function createAdaptiveWorkerTimer({
  run,
  delayForResult = () => null,
  errorRetryDelayMs = 60 * 1000,
  logger = console,
  label = "background worker",
  now = Date.now,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof run !== "function") {
    throw new TypeError("createAdaptiveWorkerTimer requires a run function.");
  }
  if (typeof delayForResult !== "function") {
    throw new TypeError("delayForResult must be a function.");
  }

  let timer = null;
  let timerDueAt = null;
  let running = false;
  let stopped = true;
  let pendingWakeDelay = null;
  let runCount = 0;

  function clearScheduledTimer() {
    if (timer) clearTimeoutImpl(timer);
    timer = null;
    timerDueAt = null;
  }

  function schedule(delayMs) {
    const delay = normalizeDelay(delayMs);
    if (stopped || delay === null) return false;

    const dueAt = now() + delay;
    if (timer && timerDueAt !== null && timerDueAt <= dueAt) {
      return false;
    }

    clearScheduledTimer();
    timerDueAt = dueAt;
    timer = setTimeoutImpl(execute, delay);
    timer?.unref?.();
    return true;
  }

  function wake(delayMs = 0) {
    const delay = normalizeDelay(delayMs);
    if (stopped || delay === null) return false;

    if (running) {
      pendingWakeDelay = pendingWakeDelay === null
        ? delay
        : Math.min(pendingWakeDelay, delay);
      return true;
    }

    return schedule(delay);
  }

  async function execute() {
    if (stopped) return;
    clearScheduledTimer();

    if (running) {
      pendingWakeDelay = pendingWakeDelay === null ? 0 : Math.min(pendingWakeDelay, 0);
      return;
    }

    running = true;
    runCount += 1;
    let result;
    let failed = false;

    try {
      result = await run();
    } catch (err) {
      failed = true;
      logger.error?.(`${label} failed:`, err);
    } finally {
      running = false;
      if (stopped) return;

      if (pendingWakeDelay !== null) {
        const delay = pendingWakeDelay;
        pendingWakeDelay = null;
        schedule(delay);
        return;
      }

      const nextDelay = failed
        ? errorRetryDelayMs
        : delayForResult(result, { runCount });
      schedule(nextDelay);
    }
  }

  function start() {
    if (!stopped) return stop;
    stopped = false;
    runCount = 0;
    pendingWakeDelay = null;
    schedule(0);
    return stop;
  }

  function stop() {
    stopped = true;
    pendingWakeDelay = null;
    clearScheduledTimer();
  }

  function state() {
    return {
      running,
      stopped,
      scheduled: Boolean(timer),
      dueAt: timerDueAt,
      runCount,
    };
  }

  return { start, stop, wake, state };
}

module.exports = { createAdaptiveWorkerTimer, normalizeDelay };
