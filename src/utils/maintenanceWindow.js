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
function createMaintenanceSchedule(intervalMs, startMs = Date.now(), { env = process.env, label } = {}) {
  const originalDelay = alignedMaintenanceDelay(intervalMs, startMs);
  // Periodic maintenance retains its full cadence after the first aligned run.
  // Align the initial deadline at most one hour earlier (not a startup sweep).
  const hourly = intervalMs >= 60 * 60 * 1000 && intervalMs % (60 * 60 * 1000) === 0;
  const firstDelay = alignmentEnabled(env) && hourly && Object.hasOwn(IDLE_OFFSETS_MS, label)
    ? commonWindowDelay(intervalMs, startMs, IDLE_OFFSETS_MS[label], intervalMs >= 6 * 60 * 60 * 1000 ? 3600000 : 1800000)
    : originalDelay;
  let nextDueAt = startMs + firstDelay;
  const cadence = Math.ceil(intervalMs / MAINTENANCE_WINDOW_MS) * MAINTENANCE_WINDOW_MS;
  return function nextDelay(nowMs = Date.now()) {
    if (!Number.isFinite(nowMs)) throw new TypeError("Maintenance clock must be finite");
    if (nextDueAt <= nowMs) {
      nextDueAt += (Math.floor((nowMs - nextDueAt) / cadence) + 1) * cadence;
    }
    return nextDueAt - nowMs;
  };
}

// Offsets are confined to a 45-second window, rather than starting all SQL
// at once. Labels are stable, explicit, and never derived from customer data.
const IDLE_OFFSETS_MS = Object.freeze({
  "WhatsApp delivery-status recovery": 0,
  "Strict RM0 result image queue": 5000,
  "Secondary WhatsApp AI media recovery": 10000,
  "Meta comment recovery worker": 15000,
  "WhatsApp extended follow-up scheduler": 20000,
  "Business App mutation recovery": 25000,
  "Secondary WhatsApp Business App media recovery": 30000,
  "Secondary WhatsApp coexistence history import": 35000,
  "accepted Inbox appointment reminder recovery": 40000,
  "Customer media cleanup recovery": 45000,
  "Meta Ads Insights sync": 12000,
  "Customer retention sweep": 27000,
  "Customer purge-job prune": 42000,
});
function alignmentEnabled(env) {
  return env.NEUTRO_IDLE_MAINTENANCE_ALIGN_ENABLED === "true";
}
function commonWindowDelay(intervalMs, nowMs, offset, phaseInterval = intervalMs) {
  const boundary = Math.floor((nowMs + intervalMs - offset) / phaseInterval) * phaseInterval + offset;
  return Math.max(1000, Math.min(intervalMs, boundary - nowMs));
}
// Only call from the existing idle fallback branches, never known deadlines.
// Round the old maximum deadline DOWN, never extending orphan recovery.
function alignedIdleRecoveryDelay(intervalMs, nowMs = Date.now(), env = process.env, label) {
  if (!alignmentEnabled(env)) return intervalMs;
  if (![30 * 60 * 1000, 60 * 60 * 1000].includes(intervalMs) ||
      !Number.isFinite(nowMs)) return intervalMs;
  const offset = Object.hasOwn(IDLE_OFFSETS_MS, label) ? IDLE_OFFSETS_MS[label] : 0;
  return commonWindowDelay(intervalMs, nowMs, offset);
}
module.exports = { MAINTENANCE_WINDOW_MS, alignedMaintenanceDelay, createMaintenanceSchedule, alignedIdleRecoveryDelay, IDLE_OFFSETS_MS };
