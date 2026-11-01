"use strict";

const { createAdaptiveWorkerTimer } = require("./adaptiveWorkerTimer");

// Keep the original 60-second recovery cadence while jobs exist. When the
// sender-owned queue is empty, stop waking Neon every minute. A new durable
// enqueue wakes immediately; a periodic 30-minute sweep also discovers
// independently committed work or work that predates a server restart.
const ACTIVE_RECOVERY_MS = 60 * 1000;
const EMPTY_RECOVERY_MS = 30 * 60 * 1000;

function createIdleAwareRecoveryWorker({
  run, hasPendingWork, label,
  activeIntervalMs = ACTIVE_RECOVERY_MS,
  emptyIntervalMs = EMPTY_RECOVERY_MS,
  ...clock
} = {}) {
  if (typeof run !== "function" || typeof hasPendingWork !== "function") {
    throw new TypeError("Recovery worker requires run and pending-work check");
  }
  if (!(activeIntervalMs > 0) || !(emptyIntervalMs >= activeIntervalMs)) {
    throw new RangeError("Recovery intervals must be positive and ordered");
  }
  return createAdaptiveWorkerTimer({
    ...clock,
    label: label || "sender recovery worker",
    errorRetryDelayMs: activeIntervalMs,
    run: async () => {
      // Pending state must be checked after processing so newly deferred jobs
      // continue to be revisited at the existing 60-second safety cadence.
      await run();
      return { pending: await hasPendingWork() };
    },
    delayForResult: result =>
      result.pending ? activeIntervalMs : emptyIntervalMs,
  });
}

module.exports = {
  createIdleAwareRecoveryWorker,
  ACTIVE_RECOVERY_MS,
  EMPTY_RECOVERY_MS,
};
