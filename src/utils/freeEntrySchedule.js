const { quietHoursStatus } = require("./quietHours");
const { freeEntryCeilingHours, EXPIRY_BUFFER_MS } = require("./whatsappFreeEntryWindow");
const MINUTE_MS = 60000;
const HOUR_MS = 3600000;

// When the final slot would become due inside quiet hours, only move it
// earlier if those same quiet hours cross the free-entry safety deadline.
// Do not move ordinary slots unnecessarily; preserve the existing spacing gate.
function effectiveSlotDueAt(firstReplyAt, slotHours, allSlots, quietHours, options = {}) {
  const first = new Date(firstReplyAt).getTime();
  if (!Number.isFinite(first) || !Number.isInteger(slotHours)) return null;
  const scheduled = first + slotHours * HOUR_MS;
  const expiration = first + freeEntryCeilingHours(firstReplyAt) * HOUR_MS - EXPIRY_BUFFER_MS;
  if (slotHours !== Math.max(...allSlots)) return new Date(scheduled);
  const quiet = quietHoursStatus(new Date(scheduled), quietHours, options);
  if (!quiet.active || !quiet.endsAt ||
      new Date(quiet.endsAt).getTime() < expiration) return new Date(scheduled);

  // Find the final safe period just before quiet hours (at least five minutes
  // beforehand), bounded to twelve hours before the scheduled final slot.
  for (let t = scheduled - 5 * MINUTE_MS; t >= scheduled - 12 * HOUR_MS; t -= 5 * MINUTE_MS) {
    const current = quietHoursStatus(new Date(t), quietHours, options);
    const next = quietHoursStatus(new Date(t + 5 * MINUTE_MS), quietHours, options);
    if (!current.active && next.active) return new Date(t);
  }
  return new Date(scheduled);
}

module.exports = { effectiveSlotDueAt };
