const pipelineRepo = require("../db/pipelineRepo");
const clinicConfig = require("../config/clinicConfig");
const { pool } = require("../db/db");
const { markBookingReadyForContact } = require("./bookingReadyOutcomeService");

// Only explicit staff confirmations with a complete calendar date can
// update CRM only AFTER Meta accepted the outbound staff-authored text. A
// proposed time, "Ok", or a date without a year is never an auto-confirmation.
function parseStaffConfirmedSlot(message, now = new Date()) {
  const text = String(message || "").trim();
  if (!text || text.length > 500 || /[?？]/u.test(text)) return null;
  if (/(?:cancelled|canceled|取消预约|取消預約|预约已取消|預約已取消)/iu.test(text)) return null;
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
  const hasDaypart = /上午|早上|下午|晚上|傍晚/u.test(text);
  // "4:00" with no AM/PM is ambiguous. Only 13:00-23:59 and 00:xx
  // are unambiguous 24-hour times in an ordinary clinic conversation.
  if (clock && !suffix && !hasDaypart && hour >= 1 && hour <= 12) return null;
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

function parseTerseStaffConfirmedSlot(message, now = new Date()) {
 const value=String(message||"").trim();
 if(!value||value.length>160||/[?？]/u.test(value)||
   /(?:not\s+confirm|not\s+booked|cancel|取消|maybe|perhaps|tbc|subject\s+to|待确认|待確認)/iu.test(value))return null;
 const confirm=/^(?:confirm(?:ed)?|comfirm(?:ed)?|确认|確認|已确认|已確認|ok(?:ay)?)\b/iu.test(value);
 const chineseConfirm=/^(?:确认|確認|已确认|已確認)/u.test(value);
 if(!confirm&&!chineseConfirm)return null;
 const clock=value.match(/\b(0?[1-9]|1[0-2])(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/iu);
 if(!clock)return null;
 let hour=Number(clock[1]),minute=Number(clock[2]||0);
 if(minute>59)return null;
 if(/^p/iu.test(clock[3]))hour=(hour%12)+12;
 else hour%=12;
 const localNow=new Date(now.getTime()+8*60*60*1000);
 let year=localNow.getUTCFullYear(),month,day;
 const explicit=value.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(20\d{2}))?\b/u);
 if(explicit){
  day=Number(explicit[1]);month=Number(explicit[2]);
  if(explicit[3])year=Number(explicit[3]);
  else{
   const candidate=new Date(Date.UTC(year,month-1,day));
   const today=new Date(Date.UTC(localNow.getUTCFullYear(),localNow.getUTCMonth(),localNow.getUTCDate()));
   if(candidate<today)year++;
  }
 } else {
  // Relative weekdays are permitted only with an EXPLICIT staff
  // confirmation, not an "OK" or provisional staff offer.
  if(!/^(?:confirm|comfirm)/iu.test(value))return null;
  const match=value.match(/\bthis\s+(mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/iu);
  if(!match)return null;
  const weekday={sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}[match[1].toLowerCase()];
  const days=(weekday-localNow.getUTCDay()+7)%7;
  const date=new Date(Date.UTC(year,localNow.getUTCMonth(),localNow.getUTCDate()+days));
  year=date.getUTCFullYear();month=date.getUTCMonth()+1;day=date.getUTCDate();
 }
 if(!Number.isInteger(day)||!Number.isInteger(month)||!Number.isInteger(year))return null;
 const utc=new Date(Date.UTC(year,month-1,day,hour-8,minute));
 const check=new Date(utc.getTime()+8*60*60*1000);
 if(check.getUTCFullYear()!==year||check.getUTCMonth()+1!==month||
    check.getUTCDate()!==day||check.getUTCHours()!==hour||
    check.getUTCMinutes()!==minute)return null;
 if(utc<new Date(now.getTime()-24*60*60*1000)||
    utc>new Date(now.getTime()+90*24*60*60*1000))return null;
 return utc.toISOString();
}

function isStaffVisitAcknowledgement(message) {
  const value = String(message || "").trim();
  if (!value || value.length > 160 || /[?？]/u.test(value)) return false;
  if (/cancel|maybe|if you|如果|可能|取消|改期|not confirmed/iu.test(value)) return false;
  // Recognise ordinary Business App confirmations such as "Comfirm this sat
  // 3.30pm" and "OK 29/11, 3pm". Without the year and an independently
  // verified appointment record, these are booking HOLDS for staff review,
  // never confirmed CRM appointments or auto-generated calendar slots.
  const visitAcknowledged = /see\s*(?:u|you)\s*[,，]?\s*(?:tmr|tomorrow|next\s+(?:mon|tue|wed|thu|fri|sat|sun)|(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?)|(?:明天|後天|后天|星期[一二三四五六日天]).{0,18}(?:见|見)|(?:confirmed|booked|已确认|已確認|已订好|已訂好).{0,50}(?:\d{1,2}[/-]\d{1,2}).{0,35}(?:\d{1,2}[:：.]\d{2})/iu.test(value);
  if (visitAcknowledged) return true;
  const affirmative = /^(?:ok(?:ay)?|confirm(?:ed)?|comfirm(?:ed)?|booked|确认|確認|确定|確定|已订好|已訂好)(?:\b|[\s,，:：])/iu.test(value);
  const day = /\b(?:this\s+|next\s+)?(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]20\d{2})?\b|(?:这|這|下)?(?:个|個)?星期[一二三四五六日天]/iu.test(value);
  const time = /\b(?:[01]?\d|2[0-3])(?:[:.]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)\b|\b(?:1[3-9]|2[0-3])[:.]\d{2}\b|(?:上午|下午|早上|傍晚)\s*\d{1,2}[点點]/iu.test(value);
  return affirmative && day && time;
}

function createStaffBookingConfirmationService({
  pipeline = pipelineRepo,
  config = clinicConfig,
  now = () => new Date(),
  database = pool,
  markPendingBooking = markBookingReadyForContact,
} = {}) {
  return async function recordStaffConfirmedBooking(contactId, staffText, { providerAccepted = false } = {}) {
    if (!providerAccepted || !["aesthetic_clinic", "tcm_clinic"].includes(config.businessType)) return null;
    const appointmentAt = parseStaffConfirmedSlot(staffText, now()) ||
      (config.businessType === 'tcm_clinic' ? parseTerseStaffConfirmedSlot(staffText, now()) : null);
    if (!appointmentAt) {
      if (!isStaffVisitAcknowledgement(staffText)) return null;
      const proof = await database.query(
        "SELECT id FROM messages WHERE contact_id=$1 AND role='assistant' " +
        "AND sent_by_username IS NOT NULL AND whatsapp_message_id IS NOT NULL " +
        "AND is_automated_follow_up=false AND BTRIM(content)=BTRIM($2) " +
        "AND created_at>=now()-interval '30 minutes' " +
        "AND COALESCE(delivery_status,'pending') IN ('pending','sent','delivered','read') " +
        "ORDER BY id DESC LIMIT 1",
        [contactId,staffText]
      );
      if (!proof.rows?.[0]?.id) return null;
      return markPendingBooking(contactId,proof.rows[0].id,{
        reason:"Booking ready: staff indicated a visit; confirm the date and time in CRM.",
        activityDescription:"Provider-verified staff visit acknowledgement; CRM confirmation still required.",
        details:{appointmentPreference:staffText},
      });
    }
    const lead = await pipeline.getActiveLeadForContact(contactId);
    if (!lead || lead.is_closed || ["visited", "cancelled"].includes(lead.appointment_status)) return null;
    // A new time for an existing booking is a rescheduling proposal, not an
    // automatic overwrite. Staff must reconcile the current CRM appointment.
    if(lead.appointment_status==="set"){
      if(lead.appointment_at &&
         new Date(lead.appointment_at).getTime()===new Date(appointmentAt).getTime())return lead;
      return null;
    }
    // Existing updateLead handles validation, stage transition, booking alert
    // cleanup and the follow-up suppression for genuinely confirmed bookings.
    return pipeline.updateLead(lead.id, { appointmentStatus: "set", appointmentAt }, "Staff chat confirmation");
  };
}
const recordStaffConfirmedBooking = createStaffBookingConfirmationService();
module.exports = {
  parseStaffConfirmedSlot,
  parseTerseStaffConfirmedSlot,
  isStaffVisitAcknowledgement,
  createStaffBookingConfirmationService,
  recordStaffConfirmedBooking,
};
