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

function bookingTimeMinutes(text) {
 const m=String(text||"").match(/\b(0?[1-9]|1[0-2])(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/iu);
 if(!m)return null;
 let hour=Number(m[1])%12;
 if(/^p/iu.test(m[3]))hour+=12;
 const minute=Number(m[2]||0);
 return minute<60?hour*60+minute:null;
}
function isTerseBookingCorroborated(staffText,appointmentAt,turns=[],staffAt) {
 const local=new Date(new Date(appointmentAt).getTime()+8*60*60*1000);
 const target=local.getUTCHours()*60+local.getUTCMinutes();
 const at=new Date(staffAt).getTime();
 if(!Number.isFinite(at)||!Array.isArray(turns))return false;
 const history=turns.map(t=>({...t,at:new Date(t.created_at).getTime()}))
   .filter(t=>Number.isFinite(t.at)&&t.at<at&&t.at>=at-7*24*60*60*1000)
   .sort((a,b)=>b.at-a.at);
 const latest=history.find(t=>t.role==="user");
 if(!latest||at-latest.at>30*60*1000||
    /(?:cannot|can't|not|no\s|cancel|取消|改期|不行|不要|不能)/iu.test(String(latest.content||"")))return false;
 const date=String(staffText||"").match(/\b(\d{1,2})\/(\d{1,2})(?:\/20\d{2})?\b/u);
 const day=String(staffText||"").match(/\bthis\s+(mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/iu);
 if(!date&&!day)return false;
 // Read the latest date explicitly mentioned by the customer, not any date
 // from the previous week. A new requested date supersedes an older one,
 // even when the latest time happens to match the staff's confirmation.
 const customerDates=history.filter(t=>t.role==="user").flatMap(t=>{
  const matches=[...String(t.content||"").matchAll(/\b(\d{1,2})\s*[\/-]\s*(\d{1,2})(?:\s*[\/-]\s*(20\d{2}))?\b/gu)];
  return matches.map(m=>({
   at:t.at,day:Number(m[1]),month:Number(m[2]),year:m[3]?Number(m[3]):null,
  }));
 });
 const newestDate=customerDates.length?Math.max(...customerDates.map(d=>d.at)):-Infinity;
 const latestDates=customerDates.filter(d=>d.at===newestDate);
 const customerDate=date&&latestDates.length>0&&latestDates.every(d=>
   d.day===local.getUTCDate()&&d.month===local.getUTCMonth()+1&&
   (d.year===null||d.year===local.getUTCFullYear()));
 // A customer proposed this specific date and most recently confirmed its
 // time. Conflicting/newer customer dates must go to manual booking review.
 if(date&&customerDate&&bookingTimeMinutes(latest.content)===target)return true;
 // Or the customer accepted a specific staff proposal, including the
 // identical time and date/weekday, before the staff confirmation.
 const agreed=/^(?:yes(?:,?\s+can)?|yes,?\s+sure|ok(?:ay)?|sure|can|boleh|可以|好|没问题|沒問題)[\s.!！。😊👌]*$/iu
   .test(String(latest.content||"").trim());
 if(!agreed)return false;
 return history.some(t=>t.role==="assistant"&&t.sent_by_username&&
   t.at<latest.at&&latest.at-t.at<=30*60*1000&&
   bookingTimeMinutes(t.content)===target&&
   (date?new RegExp("\\b0?"+Number(date[1])+"\\/0?"+Number(date[2])+"\\b","u").test(String(t.content||""))
    :new RegExp("\\bthis\\s+"+day[1]+"(?:day)?\\b","iu").test(String(t.content||""))));
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


// A reminder is evidence that staff is managing an existing visit, not proof
// of a verified CRM booking. Do not guess a calendar slot from "tmr" or "ok".
function isProactiveAppointmentReminder(message) {
  const value=String(message||"").trim();
  if(value.length<8||value.length>400||/[?？]/u.test(value))return false;
  if(/\b(?:maybe|perhaps|tentative|possibly|if you|subject to|not confirmed|not booked|unconfirmed|pending|cancel(?:led|ed)?|reschedul(?:e|ed|ing)|available\??|would you like)\b|(?:可能|如果|取消|未确认|未確認|待定|改期|不确定|尚未)|(?:belum disahkan|batal|mungkin)/iu.test(value))return false;
  if(/\b(?:promo(?:tion)?|discount|sale|trial price|offer expires|coupon|voucher|complimentary|birthday|promosi|diskaun)\b|(?:限时|限時|優惠|优惠|促销|促銷|折扣|生日)/iu.test(value))return false;
  const explicit=/(?:remind(?:er|ing)?[\s\S]{0,45}(?:appointment|booking)|(?:appointment|booking)[\s\S]{0,40}(?:remind(?:er)?|confirm(?:ed|ation)?|booked|scheduled|set for)|\bbooked\s+for\s+(?:(?:this|next)\s+)?(?:sat(?:urday)?|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?)\b|(?:预约|預約).{0,18}(?:提醒|已确认|已確認|已安排|明天|后天|後天|星期|週|周|见|見)|(?:temujanji|janji\s*temu).{0,42}(?:esok|disahkan|peringatan|diingatkan|sabtu|isnin|jumaat)|(?:peringatan|diingatkan).{0,45}(?:temujanji|janji\s*temu))/iu.test(value);
  const date=/(?:\b(?:tmr|tomorrow|today|this\s+(?:sat|sun|mon|tue|wed|thu|fri)(?:day)?|next\s+(?:sat|sun|mon|tue|wed|thu|fri)(?:day)?|(?:saturday|sunday|monday|tuesday|wednesday|thursday|friday)|esok|hari\s+ini|sabtu|ahad|isnin|selasa|rabu|khamis|jumaat)\b|(?:明天|后天|後天|星期[一二三四五六日天]|(?:本|下|这|這)周[一二三四五六日天]|(?:本|下|這)週[一二三四五六日天])|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b)/iu.test(value);
  const time=/(?:\b(?:0?[1-9]|1[0-9]|2[0-3])[:.][0-5]\d\s*(?:am|pm|pagi|petang)?\b|\b(?:0?[1-9]|1[0-2])\s*(?:am|pm)\b|(?:上午|下午|早上|晚上|傍晚)\s*\d{1,2}[点點]|[一二三四五六七八九十]\s*[点點](?:半)?)/iu.test(value);
  const casual=/(?:see\s*(?:u|you)|jumpa|(?:明天|后天|後天).{0,25}[见見]|(?:星期[一二三四五六日天]|周[一二三四五六日天]).{0,20}[见見])/iu.test(value);
  return explicit || (casual && date && time);
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
    const strictSlot=parseStaffConfirmedSlot(staffText,now());
    const terseSlot=!strictSlot&&config.businessType==="tcm_clinic"
      ?parseTerseStaffConfirmedSlot(staffText,now()):null;
    let appointmentAt=strictSlot;
    if(!strictSlot) {
      if(!terseSlot&&!isStaffVisitAcknowledgement(staffText)) {
        if(isProactiveAppointmentReminder(staffText)) {
          // This is a follow-up HOLD only, not a CRM booking, new lead,
          // notification, or automatic reschedule. Check provider evidence
          // in the persisted sender-specific conversation before recording.
          await database.query(
            `
            INSERT INTO lead_activities
              (lead_id,activity_type,description,actor,metadata)
            SELECT lead.id,'updated',
              'Verified staff appointment reminder: sales follow-ups held until booking review or subsequent lead.',
              'Automation',
              jsonb_build_object('outcome','staff_appointment_reminder',
                'staffMessageId',staff.id,'source','verified_staff_send')
            FROM messages staff
            JOIN LATERAL (
              SELECT l.id FROM leads l
              WHERE l.contact_id=staff.contact_id AND l.is_closed=false
                AND COALESCE(l.appointment_status,'none') NOT IN ('set','visited','cancelled')
              ORDER BY l.created_at DESC,l.id DESC LIMIT 1
            ) lead ON TRUE
            WHERE staff.contact_id=$1 AND staff.role='assistant'
              AND staff.sent_by_username IS NOT NULL
              AND staff.sent_by_username NOT IN
                ('Follow-up automation','Consent request automation')
              AND staff.whatsapp_message_id IS NOT NULL
              AND staff.is_automated_follow_up IS DISTINCT FROM TRUE
              AND staff.delivery_status IS DISTINCT FROM 'failed'
              AND staff.created_at>=NOW()-INTERVAL '30 minutes'
              AND BTRIM(staff.content)=BTRIM($2)
              AND NOT EXISTS (
                SELECT 1 FROM lead_activities older
                WHERE older.lead_id=lead.id
                  AND older.metadata->>'outcome'='staff_appointment_reminder'
                  AND older.metadata->>'staffMessageId'=staff.id::text
              )
            RETURNING id
            `,[contactId,staffText]
          );
        }
        return null;
      }
      // A terse "OK 29/11 3pm" cannot book anybody by itself. Require
      // provider-authenticated staff evidence and independent customer
      // agreement on the same date and time. If missing, hold for review.
      const proof=await database.query(
        `SELECT staff.id,staff.created_at,
           COALESCE((SELECT jsonb_agg(to_jsonb(prior_turn))
             FROM (SELECT prior.role,prior.content,prior.sent_by_username,prior.created_at
               FROM messages prior
               WHERE prior.contact_id=staff.contact_id
                 AND (prior.created_at,prior.id)<(staff.created_at,staff.id)
                 AND prior.created_at>=staff.created_at-INTERVAL '7 days'
                 AND (prior.role='user' OR (prior.role='assistant'
                   AND prior.sent_by_username IS NOT NULL))
               ORDER BY prior.created_at DESC,prior.id DESC LIMIT 50
             ) prior_turn),'[]'::jsonb) AS prior_turns
         FROM messages staff
         WHERE staff.contact_id=$1 AND staff.role='assistant'
           AND staff.sent_by_username IS NOT NULL
           AND staff.sent_by_username NOT IN('Follow-up automation','Consent request automation')
           AND staff.whatsapp_message_id IS NOT NULL
           AND staff.is_automated_follow_up IS DISTINCT FROM TRUE
           AND staff.delivery_status IS DISTINCT FROM 'failed'
           AND BTRIM(staff.content)=BTRIM($2)
           AND staff.created_at>=NOW()-INTERVAL '30 minutes'
         ORDER BY staff.created_at DESC,staff.id DESC LIMIT 1`,
        [contactId,staffText]
      );
      const recorded=proof.rows?.[0];
      if(!recorded?.id)return null;
      if(terseSlot&&isTerseBookingCorroborated(
        staffText,terseSlot,recorded.prior_turns,recorded.created_at)){
        appointmentAt=terseSlot;
      } else {
        return markPendingBooking(contactId,recorded.id,{
          reason:"Booking ready: staff indicated a visit; confirm the date and time in CRM.",
          activityDescription:"Staff visit acknowledgement needs independently verified customer slot agreement.",
          details:{appointmentPreference:staffText},
        });
      }
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
  isTerseBookingCorroborated,
  isStaffVisitAcknowledgement,
  isProactiveAppointmentReminder,
  createStaffBookingConfirmationService,
  recordStaffConfirmedBooking,
};
