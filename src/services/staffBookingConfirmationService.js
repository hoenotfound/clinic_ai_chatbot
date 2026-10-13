const pipelineRepo = require("../db/pipelineRepo");
const clinicConfig = require("../config/clinicConfig");

// Explicit staff confirmations with a complete unambiguous calendar date can
// update CRM only AFTER Meta accepted the outbound staff-authored text. A
// proposed time, "Ok", or a date without a year is never an auto-confirmation.
function parseStaffConfirmedSlot(message, now = new Date()) {
  const text = String(message || "").trim();
  if (!text || text.length > 500) return null;
  if (/(?:尚未|未|还没|還沒|不能|无法|無法|不)(?:.{0,5})(?:确认|確認|确定|確定|安排)|not\s+(?:yet\s+)?confirm|unconfirmed|pending|subject to confirmation/i.test(text)) {
    return null;
  }
  if (!/(?:预约|預約|时间|時間|slot|appointment|booking|temujanji)/iu.test(text) ||
      !/(?:已确认|已確認|确认成功|確認成功|确定了|確定了|已订好|已訂好|confirmed|booked|booking confirmed|disahkan)/iu.test(text)) {
    return null;
  }
  let year, month, day;
  const iso = text.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  const my = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (iso) [, year, month, day] = iso;
  else if (my) [, day, month, year] = my;
  else return null;

  const clock = text.match(/\b(\d{1,2})[:：](\d{2})\s*(a\.?m\.?|p\.?m\.?)?/iu);
  const chinese = clock ? null : text.match(/(\d{1,2})\s*[点點]\s*(半|\d{1,2}\s*分)?/u);
  if (!clock && !chinese) return null;
  let hour = Number(clock ? clock[1] : chinese[1]);
  const minute = clock ? Number(clock[2]) : chinese?.[2]
    ? chinese[2] === "半" ? 30 : Number(chinese[2].replace(/\s*分/, "")) : 0;
  const suffix = clock ? String(clock[3] || "") : "";
  if (/p\.?m/i.test(suffix) || /下午|晚上|傍晚/u.test(text)) {
    if (hour < 12) hour += 12;
  } else if (/a\.?m/i.test(suffix) || /上午|早上/u.test(text)) {
    if (hour === 12) hour = 0;
  } else if (chinese) {
    // Chinese bare 4点 is ambiguous unless the daypart is stated.
    return null;
  }
  if (hour > 23 || hour < 0 || minute > 59 || minute < 0) return null;
  const instant = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hour - 8, minute));
  // Reject invalid dates and impossible/old offers. Malaysia uses UTC+08.
  const localCheck = new Date(instant.getTime() + 8 * 60 * 60 * 1000);
  if (localCheck.getUTCFullYear() !== Number(year) ||
      localCheck.getUTCMonth() + 1 !== Number(month) ||
      localCheck.getUTCDate() !== Number(day)) return null;
  if (instant.getTime() < now.getTime() - 24 * 60 * 60 * 1000 ||
      instant.getTime() > now.getTime() + 366 * 24 * 60 * 60 * 1000) return null;
  return instant.toISOString();
}

function createStaffBookingConfirmationService({
  pipeline = pipelineRepo,
  config = clinicConfig,
  now = () => new Date(),
} = {}) {
  return async function recordStaffConfirmedBooking(contactId, staffText, { providerAccepted = false } = {}) {
    if (!providerAccepted || !["aesthetic_clinic", "tcm_clinic"].includes(config.businessType)) return null;
    const appointmentAt = parseStaffConfirmedSlot(staffText, now());
    if (!appointmentAt) return null;
    const lead = await pipeline.getActiveLeadForContact(contactId);
    if (!lead || lead.is_closed || ["visited", "cancelled"].includes(lead.appointment_status)) return null;
    // Existing updateLead handles validation, stage transition, booking alert
    // cleanup and the follow-up suppression for genuinely confirmed bookings.
    return pipeline.updateLead(lead.id, { appointmentStatus: "set", appointmentAt }, "Staff chat confirmation");
  };
}
const recordStaffConfirmedBooking = createStaffBookingConfirmationService();
module.exports = {
  parseStaffConfirmedSlot,
  createStaffBookingConfirmationService,
  recordStaffConfirmedBooking,
};
