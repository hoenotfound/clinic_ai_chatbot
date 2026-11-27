"use strict";

// Non-urgent hourly/daily jobs share five-minute clock boundaries. Defer at
// most five minutes; never apply this to customer sends or stored retry times.
const MAINTENANCE_WINDOW_MS = 5 * 60 * 1000;
function alignedMaintenanceDelay(intervalMs, nowMs = Date.now()) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(nowMs)) {
    throw new TypeError("Maintenance interval and clock must be finite");
  }
  return Math.ceil((nowMs + intervalMs) / MAINTENANCE_WINDOW_MS) * MAINTENANCE_WINDOW_MS - nowMs;
}
// Keep the first scheduled boundary as the anchor. Completion time must not
// shift later runs; a long-running job skips missed slots instead of catching up.
function createMaintenanceSchedule(intervalMs, startMs = Date.now()) {
  let nextDueAt = startMs + alignedMaintenanceDelay(intervalMs, startMs);
  const cadence = Math.ceil(intervalMs / MAINTENANCE_WINDOW_MS) * MAINTENANCE_WINDOW_MS;
  return function nextDelay(nowMs = Date.now()) {
    if (!Number.isFinite(nowMs)) throw new TypeError("Maintenance clock must be finite");
    if (nextDueAt <= nowMs) {
      nextDueAt += (Math.floor((nowMs - nextDueAt) / cadence) + 1) * cadence;
    }
    return nextDueAt - nowMs;
  };
}

// Only call after proving that there is no actionable work or known deadline.
// Use common UTC boundaries (also local hour boundaries in Malaysia).
// Round the old maximum deadline DOWN, never extending orphan recovery.
// A near-boundary first sweep may occur early once; later sweeps align.
function alignedIdleRecoveryDelay(intervalMs, nowMs = Date.now(), env = process.env) {
  if (env.NEUTRO_IDLE_MAINTENANCE_ALIGN_ENABLED !== "true") return intervalMs;
  if (![30 * 60 * 1000, 60 * 60 * 1000].includes(intervalMs) ||
      !Number.isFinite(nowMs)) return intervalMs;
  const boundary = Math.floor((nowMs + intervalMs) / intervalMs) * intervalMs;
  return Math.max(1000, Math.min(intervalMs, boundary - nowMs));
}
module.exports = { MAINTENANCE_WINDOW_MS, alignedMaintenanceDelay, createMaintenanceSchedule, alignedIdleRecoveryDelay };
