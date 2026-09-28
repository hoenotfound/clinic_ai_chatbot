let phase = "starting";
let readyAt = null;
let failedAt = null;

function isReady() {
  return phase === "ready";
}

function snapshot() {
  return {
    phase,
    ready: isReady(),
    readyAt,
    failedAt,
  };
}

function markReady(now = new Date()) {
  phase = "ready";
  readyAt = now;
  failedAt = null;
  return snapshot();
}

function markFailed(now = new Date()) {
  phase = "failed";
  failedAt = now;
  readyAt = null;
  return snapshot();
}

function livenessHandler(_req, res) {
  return res.status(200).json({
    status: "alive",
  });
}

function readinessHandler(_req, res) {
  const state = snapshot();
  return res.status(state.ready ? 200 : 503).json({
    status: state.ready ? "ready" : state.phase,
    ready: state.ready,
  });
}

function rootReadinessHandler(_req, res) {
  if (isReady()) {
    return res.status(200).send("AI messaging bot is running.");
  }
  return res.status(503).send(
    phase === "failed"
      ? "AI messaging bot startup failed."
      : "AI messaging bot is starting."
  );
}

function requireReady(_req, res, next) {
  if (isReady()) return next();
  return res.status(503).json({
    error: phase === "failed"
      ? "Service startup failed."
      : "Service is starting.",
    code: phase === "failed"
      ? "service_startup_failed"
      : "service_starting",
  });
}

function resetForTests() {
  phase = "starting";
  readyAt = null;
  failedAt = null;
}

module.exports = {
  isReady,
  livenessHandler,
  markFailed,
  markReady,
  readinessHandler,
  requireReady,
  rootReadinessHandler,
  resetForTests,
  snapshot,
};
