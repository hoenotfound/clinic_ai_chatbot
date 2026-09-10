const CLIENT_LIFECYCLE_STATUSES = Object.freeze([
  "setup",
  "trial",
  "live",
  "paused",
]);
const CLIENT_LIFECYCLE_SET = new Set(CLIENT_LIFECYCLE_STATUSES);
const DEFAULT_NEW_CLIENT_LIFECYCLE = "setup";
const LEGACY_CLIENT_LIFECYCLE = "live";

function normalizeClientLifecycle(value, {
  fallback = DEFAULT_NEW_CLIENT_LIFECYCLE,
} = {}) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  if (!CLIENT_LIFECYCLE_SET.has(raw)) {
    const error = new Error(
      `Unsupported client lifecycle "${value}". Use: ${CLIENT_LIFECYCLE_STATUSES.join(", ")}.`,
    );
    error.code = "OPS_CLIENT_LIFECYCLE_INVALID";
    throw error;
  }
  return raw;
}

function lifecyclePolicy(value, {
  fallback = LEGACY_CLIENT_LIFECYCLE,
} = {}) {
  const status = normalizeClientLifecycle(value, { fallback });
  return {
    status,
    backgroundPollingEnabled: status === "live",
    manualRefreshAllowed: status !== "paused",
  };
}

module.exports = {
  CLIENT_LIFECYCLE_STATUSES,
  DEFAULT_NEW_CLIENT_LIFECYCLE,
  LEGACY_CLIENT_LIFECYCLE,
  lifecyclePolicy,
  normalizeClientLifecycle,
};
