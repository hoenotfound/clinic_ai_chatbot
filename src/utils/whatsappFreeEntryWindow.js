// Meta extended the free entry point ceiling from 72h to UP TO 7 days
// on 2026-09-28. This is not a promise of free billing until hour 168.
const CHANGEOVER_AT = Date.parse("2026-09-28T00:00:00Z");
const CUSTOMER_SERVICE_MS = 24 * 60 * 60 * 1000;
const EXPIRY_BUFFER_MS = 60 * 60 * 1000;
const DEFAULT_SLOTS_HOURS = Object.freeze([26, 50, 74, 98, 122, 162]);

function freeEntryCeilingHours(firstReplyAt) {
  const timestamp = new Date(firstReplyAt).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return timestamp >= CHANGEOVER_AT ? 168 : 72;
}

function eligibleFreeEntryTime({
  firstInboundAt,
  firstReplyAt,
  now = new Date(),
  slotHours,
  lastInboundAt,
  evidenceType,
  sourceIsCtwa,
  earlyDueAt = null,
  maxCeilingHours = 72,
} = {}) {
  const inbound = new Date(firstInboundAt).getTime();
  const reply = new Date(firstReplyAt).getTime();
  const current = new Date(now).getTime();
  const last = new Date(lastInboundAt).getTime();
  const ceilingHours = Math.min(freeEntryCeilingHours(firstReplyAt),
    maxCeilingHours === 168 ? 168 : 72);
  if (
    !sourceIsCtwa ||
    evidenceType !== "free_entry_point" ||
    ![inbound, reply, current, last].every(Number.isFinite) ||
    reply < inbound ||
    reply - inbound >= CUSTOMER_SERVICE_MS ||
    last < inbound ||
    !Number.isInteger(slotHours) ||
    slotHours < 25 ||
    slotHours >= ceilingHours
  ) return false;
  const regularDueAt = reply + slotHours * 3600000;
  const permittedEarlier = earlyDueAt === null ? regularDueAt :
    Math.max(reply + 24 * 3600000, Math.min(regularDueAt, new Date(earlyDueAt).getTime()));
  if (!Number.isFinite(permittedEarlier)) return false;
  return current >= permittedEarlier &&
    current >= last + CUSTOMER_SERVICE_MS &&
    current < reply + ceilingHours * 3600000 - EXPIRY_BUFFER_MS;
}

function configuredSlots(env = process.env) {
  const input = String(env.WHATSAPP_FEP_SLOT_HOURS || "26,50,74,98,122,162");
  const slots = input.split(",").map((value) => Number(value.trim()));
  if (!slots.length || slots.length > 6 ||
    slots.some((slot) => !Number.isInteger(slot) || slot < 25 || slot > 166) ||
    new Set(slots).size !== slots.length) return [];
  return slots.sort((a, b) => a - b);
}

function freeEntryEnabled(env = process.env) {
  return String(env.WHATSAPP_FEP_FOLLOWUPS_ENABLED || "").trim().toLowerCase() === "true";
}

module.exports = {
  CUSTOMER_SERVICE_MS,
  DEFAULT_SLOTS_HOURS,
  EXPIRY_BUFFER_MS,
  eligibleFreeEntryTime,
  configuredSlots,
  freeEntryCeilingHours,
  freeEntryEnabled,
};
