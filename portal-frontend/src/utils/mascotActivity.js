// Only use established, selected-conversation events. No inference from an
// AI mode flag, generic refresh, redacted event or optimistic message.
const DURATIONS = { greeting: 1500, success: 2500, alert: 2600 };
const PRIORITY = { greeting: 1, success: 2, alert: 3 };

export function classifyMascotEvent(payload, selectedId) {
  if (!payload || selectedId == null || payload.contactId == null ||
      Number(payload.contactId) !== Number(selectedId) || payload.messageId == null) return null;
  const contactId = Number(selectedId);
  if (!Number.isSafeInteger(contactId) || contactId < 1) return null;
  if (payload.deliveryStatus === "failed") {
    return { kind: "alert", contactId, key: "failed:" + payload.messageId };
  }
  if (payload.reason === "message") {
    return { kind: "greeting", contactId, key: "message:" + payload.messageId };
  }
  return null;
}

const DEDUP_MS = 30000;
const GREETING_COOLDOWN_MS = 5000;
const MAX_RECENT = 64;
export function nextMascotActivity(previous, event, now) {
  if (!event || !Object.hasOwn(DURATIONS, event.kind) || !Number.isFinite(now)) return previous;
  const recent = (previous?.recent || []).filter(item => now - item.at < DEDUP_MS);
  if (recent.some(item => item.contactId === event.contactId && item.key === event.key)) return previous;
  const sameContact = previous?.contactId === event.contactId;
  if (sameContact && now < previous.until && PRIORITY[previous.kind] > PRIORITY[event.kind]) return previous;
  if (event.kind === "greeting" && recent.some(item => item.kind === "greeting" &&
      item.contactId === event.contactId && now - item.at < GREETING_COOLDOWN_MS)) return previous;
  return {
    ...event, sequence: (previous?.sequence ?? 0) + 1,
    until: now + DURATIONS[event.kind],
    recent: [...recent, { contactId: event.contactId, key: event.key, kind: event.kind, at: now }].slice(-MAX_RECENT),
  };
}
