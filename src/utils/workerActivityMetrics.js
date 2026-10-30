"use strict";

// Operational counters only. Labels come from hardcoded worker names, never
// requests, customer details, SQL or Meta identifiers.
const MAX_WORKERS = 40;
const activity = new Map();

function recordWorkerRun(label, elapsedMs, failed = false) {
  const key = typeof label === "string" && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/.test(label)
    ? label : "unnamed worker";
  if (!activity.has(key) && activity.size >= MAX_WORKERS) return;
  const previous = activity.get(key) || { runs: 0, failures: 0, totalMs: 0, maxMs: 0 };
  const duration = Number.isFinite(elapsedMs) && elapsedMs >= 0 ? Math.round(elapsedMs) : 0;
  previous.runs += 1;
  previous.failures += failed ? 1 : 0;
  previous.totalMs += duration;
  previous.maxMs = Math.max(previous.maxMs, duration);
  activity.set(key, previous);
}

function takeWorkerActivity() {
  const result = [...activity].map(([label, values]) => ({ label, ...values }));
  activity.clear();
  return result;
}

module.exports = { recordWorkerRun, takeWorkerActivity };
