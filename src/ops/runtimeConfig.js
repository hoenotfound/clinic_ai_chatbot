const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;
const MIN_POLL_INTERVAL_MS = 60 * 1000;
const DEFAULT_OFFLINE_AFTER_MS = 15 * 60 * 1000;

function pollIntervalMs(env = process.env) {
  const parsed = Number(env.OPS_POLL_INTERVAL_MS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_POLL_INTERVAL_MS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.floor(parsed));
}

function offlineAfterMs(env = process.env) {
  return Math.max(DEFAULT_OFFLINE_AFTER_MS, pollIntervalMs(env) * 3);
}

module.exports = {
  DEFAULT_OFFLINE_AFTER_MS,
  DEFAULT_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  offlineAfterMs,
  pollIntervalMs,
};
