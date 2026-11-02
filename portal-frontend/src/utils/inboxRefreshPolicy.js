// Share identical in-flight Inbox refreshes while preserving a trailing refresh
// when a new event arrives. No timer, stale cache, or customer-message changes.
export function createSingleFlightInboxRefresh() {
  let inFlight = null;
  let queued = false;
  let latestRun = null;

  return function requestRefresh(run) {
    if (typeof run !== "function") throw new TypeError("Inbox refresh must be a function.");
    latestRun = run;
    if (inFlight) {
      queued = true;
      return inFlight;
    }

    // A new event while a request is in flight always gets one final fresh
    // snapshot. Any burst of events is folded into that final request.
    async function execute() {
      try {
        do {
          queued = false;
          await latestRun(() => { queued = true; });
        } while (queued);
      } finally {
        // Release even after a failed request; later events can always retry.
        inFlight = null;
      }
    }
    inFlight = execute();
    return inFlight;
  };
}

// Known contact or a uniquely matching current lead can use the existing
// permission-checked single-contact summary endpoint. Unknown/global events,
// missing leads and redacted restricted-staff SSE signals must reload the full
// Inbox list to preserve staff access and newly assigned contacts.
export function pipelineRefreshContactId(payload, conversations) {
  const directId = Number(payload?.contactId);
  if (Number.isSafeInteger(directId) && directId > 0) return directId;

  const leadId = Number(payload?.leadId);
  if (!Number.isSafeInteger(leadId) || leadId <= 0 || !Array.isArray(conversations)) {
    return null;
  }
  const matching = new Set();
  for (const row of conversations) {
    if (Number(row?.lead_id) !== leadId) continue;
    const id = Number(row?.contact_id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    matching.add(id);
    if (matching.size > 1) return null;
  }
  return matching.size === 1 ? [...matching][0] : null;
}


// The initial Inbox snapshot must be taken after the first live connection
// opens, so events between the snapshot and subscription cannot be lost.
// If SSE is slow/unavailable, start an ordinary full read after a short grace
// period; a later first connection still reconciles the gap safely.
// Reconnects always refresh the full list to recheck staff permissions.
export function createInboxLiveStartup({
  loadInitial, refreshOnReconnect, graceMs = 450,
  schedule = setTimeout, cancel = clearTimeout,
} = {}) {
  if (typeof loadInitial !== "function" || typeof refreshOnReconnect !== "function" ||
      typeof schedule !== "function" || typeof cancel !== "function") {
    throw new TypeError("Inbox startup requires initial and reconnect refreshes.");
  }
  let firstOpenSeen = false;
  let initialRequested = false;
  let stopped = false;
  let fallbackTimer = schedule(() => {
    fallbackTimer = null;
    if (stopped || firstOpenSeen || initialRequested) return;
    initialRequested = true;
    loadInitial();
  }, graceMs);

  return {
    onOpen() {
      if (stopped) return;
      if (!firstOpenSeen) {
        firstOpenSeen = true;
        if (fallbackTimer != null) {
          cancel(fallbackTimer);
          fallbackTimer = null;
        }
        if (!initialRequested) {
          initialRequested = true;
          loadInitial();
          return;
        }
      }
      // After an offline fallback (or on any reconnect), the full refresh is
      // necessary: customer messages and staff permissions might have changed.
      refreshOnReconnect();
    },
    stop() {
      stopped = true;
      if (fallbackTimer != null) cancel(fallbackTimer);
      fallbackTimer = null;
    },
  };
}
