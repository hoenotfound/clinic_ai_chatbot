export function shouldRefreshLeadActivities(eventData, leadId) {
  const selectedLeadId = Number(leadId);
  if (!Number.isSafeInteger(selectedLeadId) || selectedLeadId < 1) return false;

  let payload = eventData;
  if (typeof eventData === "string") {
    try {
      payload = eventData ? JSON.parse(eventData) : {};
    } catch {
      // Treat malformed/redacted realtime payloads as generic refresh signals.
      // The API read still enforces the current user's lead permissions.
      payload = {};
    }
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    payload = {};
  }

  // Restricted staff deliberately receive {} for pipeline_changed events so
  // lead ids are never leaked over SSE. In that case refresh the currently
  // open lead and let the normal activities endpoint re-check authorization.
  if (payload.leadId == null) return true;

  const eventLeadId = Number(payload.leadId);
  return Number.isSafeInteger(eventLeadId) && eventLeadId === selectedLeadId;
}
