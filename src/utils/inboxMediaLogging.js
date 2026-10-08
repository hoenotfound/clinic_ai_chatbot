// Successful Inbox media requests should produce one concise production log.
// Enable per-stage timing temporarily with INBOX_MEDIA_VERBOSE_LOGS=true.
function verboseInboxMediaLogs() {
  return /^(true|1|yes)$/i.test(String(process.env.INBOX_MEDIA_VERBOSE_LOGS || ""));
}

function logInboxMediaSummary(timings, details = {}) {
  const outcome = details.outcome || timings.outcome || "accepted";
  const stageMs = {};
  for (const [key, value] of Object.entries(timings)) {
    if (key.endsWith("Ms") && key !== "startedAtMs" && key !== "totalMs" &&
        typeof value === "number" && Number.isFinite(value)) {
      stageMs[key] = value;
    }
  }
  const summary = {
    requestId: timings.requestId || null,
    type: details.type || null,
    contactId: details.contactId ?? timings.contactId ?? null,
    channel: details.channel || timings.channel || null,
    bytes: details.bytes ?? timings.bytes ?? null,
    outcome,
    httpStatus: details.httpStatus ?? null,
    ...(timings.persistenceIssue ? { persistenceIssue: true } : {}),
    totalMs: Math.max(0, Date.now() - (timings.startedAtMs || Date.now())),
    stageMs,
    ...(timings.failedStage ? { failedStage: timings.failedStage } : {}),
  };
  const isProblem = !["accepted", "submitted"].includes(outcome) ||
    timings.persistenceIssue === true || !!timings.failedStage ||
    (summary.httpStatus !== null && summary.httpStatus >= 400);
  (isProblem ? console.warn : console.info)("[Inbox media summary]", JSON.stringify(summary));
}

// Response hooks also cover early policy rejections, validation errors and
// aborted uploads. The once-only guard prevents close/finish double logging.
function trackInboxMediaResponse(req, res, type, timings) {
  let logged = false;
  const finish = (aborted = false) => {
    if (logged) return;
    logged = true;
    const httpStatus = res.statusCode;
    const outcome = aborted ? "aborted" : timings.outcome ||
      (httpStatus >= 400 ? "rejected" : "accepted");
    logInboxMediaSummary(timings, {
      type,
      contactId: req.params?.contactId,
      httpStatus,
      outcome,
    });
  };
  res.once("finish", () => finish(false));
  res.once("close", () => finish(!res.writableFinished));
}

module.exports = {
  verboseInboxMediaLogs,
  logInboxMediaSummary,
  trackInboxMediaResponse,
};
