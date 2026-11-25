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

export function nextMascotActivity(previous, event, now) {
  if (!event || !Object.hasOwn(DURATIONS, event.kind)) return previous;
  const sameContact = previous?.contactId === event.contactId;
  if (sameContact && previous.key === event.key && now < previous.until + 10000) return previous;
  if (sameContact && now < previous.until && PRIORITY[previous.kind] > PRIORITY[event.kind]) return previous;
  return {
    ...event, sequence: (previous?.sequence ?? 0) + 1,
    until: now + DURATIONS[event.kind],
  };
}
