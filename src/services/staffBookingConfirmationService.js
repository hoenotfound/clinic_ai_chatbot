const pipelineRepo = require("../db/pipelineRepo");
const clinicConfig = require("../config/clinicConfig");
const { pool } = require("../db/db");
const { CONVERSATION_LOCK_NAMESPACE } = require("../db/conversationLock");
const { HOLD_SQL, CONFIRMATION_HOLD_SQL, MODEL_CONFIRMATION_HOLD_SQL, RESCHEDULE_DISCREPANCY_SQL } = require("../db/staffAppointmentReminderRepo");
const { isProactiveAppointmentReminder } = require("../utils/staffAppointmentReminderText");
const { markBookingReadyForContact } = require("./bookingReadyOutcomeService");
const {isBriefAcceptance,hasSpecificStaffTimeOffer}=require("./staffAppointmentAcceptanceService");
const realtimeEvents=require("../utils/realtimeEvents");
const {verifiedStaffSlot}=require("../utils/verifiedStaffAppointmentSlot");

// Only explicit staff confirmations with a complete calendar date can
// update CRM only AFTER Meta accepted the outbound staff-authored text. A
// proposed time, "Ok", or a date without a year is never an auto-confirmation.
// Calendar validation is separate from model intent. Require one future
// concrete slot (not a range or a choice), and check clinic hours when known.
function trustedStaffTurn(t){
 return t?.role==="assistant"&&!!t.sent_by_username&&
  !["Follow-up automation","Consent request automation"].includes(t.sent_by_username)&&
  t.is_forwarded!==true&&t.is_automated_follow_up!==true&&!t.whatsapp_customer_mutation&&
  !t.media_mime_type&&!t.media_url&&!["failed","unknown","cancelled"].includes(t.delivery_status)&&
  // Older isolated unit fixtures omit the column; production always selects it.
  (!Object.hasOwn(t,"whatsapp_message_id")||String(t.whatsapp_message_id||"").startsWith("wamid."));
}
function staffOfferMatches(t,appointmentAt){
 if(!trustedStaffTurn(t)||!hasSpecificStaffTimeOffer(t.content)&&
  !/\b(?:can\?|can\s*[?？])|(?:可以|方便)[?？]/iu.test(String(t.content||"")))return false;
 if(/\b(?:not available|unavailable|cannot|can['’]t|cancel|fully booked)\b|不能|没空|沒空|不可以|取消|已满|已滿/iu.test(String(t.content||"")))return false;
 return verifiedStaffSlot(t.content,new Date(t.at),new Date(t.at),null,{allowUnconfigured:true})===appointmentAt;
}
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
 const namedDay=value.match(/\b(mon|tue|wed|thu|fri|sat|sun)(?:day)?\b/iu);
 if(namedDay&&check.getUTCDay()!==({sun:0,mon:1,tue:2,wed:3,thu:4,fri:5,sat:6}[namedDay[1].toLowerCase()]))return null;
 if(utc<new Date(now.getTime()-24*60*60*1000)||
    utc>new Date(now.getTime()+90*24*60*60*1000))return null;
 return utc.toISOString();
}


function parseNaturalStaffConfirmedSlot(message,now=new Date()){
 const v=String(message||"").trim();
 if(!v||v.length>300||/[?？]/u.test(v)||
   /(?:not\s+(?:yet\s+)?confirm|not booked|unconfirmed|pending|tbc|maybe|cancel|取消|待确认|待確認|尚未确认)/iu.test(v)||
   !/(?:appointment|booking|预约|預約)/iu.test(v)||
   !/(?:is\s+confirm(?:ed)?|confirmed|has\s+been\s+booked|已确认|已確認|已订好|已訂好|确认成功|確認成功)/iu.test(v))return null;
 const d=v.match(/\b(\d{1,2})\s*[\/-]\s*(\d{1,2})(?:\s*[\/-]\s*(20\d{2}))?\b/u);
 const t=v.match(/\b(0?[1-9]|1[0-2])(?:(?:[:.](\d{2}))|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/iu);
 if(!d||!t)return null;
 const clock=t[1]+":"+String(t[2]||t[3]||"00").padStart(2,"0")+t[4];
 const result=parseTerseStaffConfirmedSlot("Confirm "+d[1]+"/"+d[2]+
   (d[3]?"/"+d[3]:"")+" "+clock,now);
 if(!result)return null;
 const weekday=/\b(?:nxt|next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b/iu.exec(v);
 if(weekday){
   const named={mon:1,tue:2,wed:3,thu:4,fri:5,sat:6,sun:0}[weekday[1].slice(0,3).toLowerCase()];
   const local=new Date(new Date(result).getTime()+8*3600_000);
   if(local.getUTCDay()!==named)return null;
 }
 return result;
}

function isContextualStaffBookingConfirmed(staffText,turns=[],staffAt,now=new Date()){
 const v=String(staffText||"").trim();
 if(!v||v.length>150||/[?？]/u.test(v)||
   !/(?:confirm(?:ed)?\s+appointment|appointment\s+(?:is\s+)?confirm(?:ed)?|预约已确认|預約已確認)/iu.test(v)||
   /(?:not|pending|maybe|tbc|cancel|取消|未确认|未確認|待确认|待確認)/iu.test(v))return null;
 const at=new Date(staffAt).getTime();
 if(!Number.isFinite(at)||!Array.isArray(turns))return null;
 const prior=turns.map(t=>({...t,at:new Date(t.created_at).getTime()}))
   .filter(t=>Number.isFinite(t.at)&&t.at<at&&t.at>=at-48*3600_000)
   .sort((a,b)=>b.at-a.at);
 const last=prior.find(t=>t.role==="user");
 if(!last||at-last.at>30*60_000||
   /(?:no|not|cancel|cannot|改期|不行|不能|取消|不要)/iu.test(String(last.content||"")))return null;
 function slot(text){
   const raw=String(text||"");
   const d=raw.match(/\b(\d{1,2})\s*[\/-]\s*(\d{1,2})(?:\s*[\/-]\s*(20\d{2}))?\b/u);
   const t=raw.match(/\b(0?[1-9]|1[0-2])(?:(?:[:.](\d{2}))|([0-5]\d))?\s*(a\.?m\.?|p\.?m\.?)\b/iu);
   if(!d||!t)return null;
   return parseTerseStaffConfirmedSlot("Confirm "+d[1]+"/"+d[2]+
    (d[3]?"/"+d[3]:"")+" "+t[1]+":"+
    String(t[2]||t[3]||"00").padStart(2,"0")+t[4],now);
 }
 const selected=slot(last.content);
 if(!selected)return null;
 const proposal=staffOfferMatches(prior.find(t=>t.at<last.at),selected);
 if(!proposal)return null;
 if(prior.some(t=>t.at>last.at &&
   (/(?:取消|改期|不能|不行|cancel|reschedul|not available)/iu.test(t.content||"") ||
     (slot(t.content)&&slot(t.content)!==selected))))return null;
 return selected;
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
 if(latest.is_forwarded||latest.whatsapp_customer_mutation||latest.media_mime_type)return false;
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
 const agreed=isBriefAcceptance(latest.content)||
   /^(?:yes(?:,?\s+can)?|yes,?\s+sure|ok(?:ay)?|sure|can|boleh|可以|好|没问题|沒問題)[\s.!！。😊👌]*$/iu.test(String(latest.content||"").trim());
 if(!agreed)return false;
 const previous=history.find(t=>t.at<latest.at);
 if(!previous||latest.at-previous.at>30*60*1000)return false;
 // The agreement must answer the immediately preceding real staff offer.
 // A later promotion, alternative time, bot message or forwarded message
 // cannot corroborate an older offer.
 if(history.some(t=>t.at>latest.at&&trustedStaffTurn(t)&&
   verifiedStaffSlot(t.content,new Date(t.at),new Date(t.at),null,{allowUnconfigured:true})!==null&&
   verifiedStaffSlot(t.content,new Date(t.at),new Date(t.at),null,{allowUnconfigured:true})!==appointmentAt))return false;
 return staffOfferMatches(previous,appointmentAt);
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

function createStaffBookingConfirmationService({
  pipeline = pipelineRepo,
  config = clinicConfig,
  now = () => new Date(),
  database = pool,
  markPendingBooking = markBookingReadyForContact,
} = {}) {
  return async function recordStaffConfirmedBooking(contactId, staffText, { providerAccepted = false, messageId = null } = {}) {
    if (!providerAccepted || !["aesthetic_clinic", "tcm_clinic"].includes(config.businessType)) return null;
    const strictSlot=parseStaffConfirmedSlot(staffText,now()) ||
      (config.businessType==="tcm_clinic"?parseNaturalStaffConfirmedSlot(staffText,now()):null);
    const terseSlot=!strictSlot&&config.businessType==="tcm_clinic"
      ?parseTerseStaffConfirmedSlot(staffText,now()):null;
    let appointmentAt=strictSlot;
    let recordedProof=null;
    const neutro=config.businessType==="tcm_clinic"&&/^neutro\s+sense\b/iu.test(String(config.businessName||config.clinicName||""))&&config.aiAppointmentRecognition!==false;
    // A routine staff reminder is evidence of a staff-managed visit, not
    // permission to fabricate a CRM appointment or send a booking alert.
    // The provider-authenticated original message ID is required for a
    // recoverable, replay-safe follow-up hold.
    const persistStaffHold=async(confirmation=false,sourceMessageId=messageId,discrepancySlot=null)=>{
      const sourceId=Number(sourceMessageId);
      if(!Number.isSafeInteger(sourceId)||sourceId<=0)return null;
      const holdSql=discrepancySlot?RESCHEDULE_DISCREPANCY_SQL:confirmation?CONFIRMATION_HOLD_SQL:HOLD_SQL;
      const args=discrepancySlot?[contactId,sourceId,staffText,discrepancySlot]:[contactId,sourceId,staffText];
      // Serialize duplicate webhook deliveries on the existing conversation
      // lock. The NOT EXISTS check then becomes race-safe without a migration.
      if(typeof database.connect === "function"){
        const client=await database.connect();
        try{
          await client.query("BEGIN");
          await client.query(`SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)`,[contactId]);
          const held=await client.query(holdSql,args);
          await client.query("COMMIT");
          if(confirmation&&held.rows?.length)realtimeEvents.publish("conversation_changed",{contactId,reason:"booking_confirmation_pending"});
        }catch(error){
          await client.query("ROLLBACK").catch(()=>{});
          throw error;
        }finally{client.release();}
      }else{
        const held=await database.query(holdSql,args);
        if(confirmation&&held.rows?.length)realtimeEvents.publish("conversation_changed",{contactId,reason:"booking_confirmation_pending"});
      }
      return null;
    };
    // A colloquial staff farewell with a full future slot is sufficient to
    // raise a discrepancy, never sufficient to auto-confirm a new booking.
    const farewellSlot=neutro&&/^(?:c\s*u|see\s+(?:you|u))\s+on\b/iu.test(String(staffText||"").trim())&&
      !/[?？]/u.test(staffText) ? verifiedStaffSlot(staffText,now(),now(),config.hours) : null;
    if(farewellSlot)return persistStaffHold(true,messageId,farewellSlot);
    if(!strictSlot&&!terseSlot&&isProactiveAppointmentReminder(staffText)) return persistStaffHold();
    if(!strictSlot) {
      const contextualCandidate=config.businessType==="tcm_clinic" &&
         /(?:confirm(?:ed)?\s+appointment|appointment\s+(?:is\s+)?confirm(?:ed)?|预约已确认|預約已確認)/iu.test(staffText);
       if(!terseSlot&&!contextualCandidate&&!isStaffVisitAcknowledgement(staffText))return null;
      // A terse "OK 29/11 3pm" cannot book anybody by itself. Require
      // provider-authenticated staff evidence and independent customer
      // agreement on the same date and time. If missing, hold for review.
      const proof=await database.query(
        `SELECT staff.id,staff.created_at,
           COALESCE((SELECT jsonb_agg(to_jsonb(prior_turn))
             FROM (SELECT prior.id,prior.role,prior.content,prior.sent_by_username,prior.created_at,
                 prior.is_forwarded,prior.is_automated_follow_up,prior.whatsapp_customer_mutation,
                 prior.media_mime_type,prior.media_url,prior.delivery_status,prior.whatsapp_message_id
               FROM messages prior
               WHERE prior.contact_id=staff.contact_id
                 AND (prior.created_at,prior.id)<(staff.created_at,staff.id)
                 AND prior.created_at>=staff.created_at-INTERVAL '7 days'
                 AND prior.role IN ('user','assistant')
               ORDER BY prior.created_at DESC,prior.id DESC LIMIT 50
             ) prior_turn),'[]'::jsonb) AS prior_turns
         FROM messages staff
         WHERE staff.contact_id=$1 AND staff.role='assistant'
           AND staff.sent_by_username IS NOT NULL
           AND staff.sent_by_username NOT IN('Follow-up automation','Consent request automation')
           AND staff.whatsapp_message_id LIKE 'wamid.%'
           AND staff.is_forwarded IS DISTINCT FROM TRUE AND staff.whatsapp_customer_mutation IS NULL
           AND staff.media_mime_type IS NULL AND staff.media_url IS NULL
           AND staff.is_automated_follow_up IS DISTINCT FROM TRUE
           AND COALESCE(staff.delivery_status,'pending') NOT IN ('failed','unknown','cancelled')
           AND ($3::bigint IS NULL OR staff.id=$3)
           AND BTRIM(staff.content)=BTRIM($2)
           AND staff.created_at>=NOW()-INTERVAL '30 minutes'
         ORDER BY staff.created_at DESC,staff.id DESC LIMIT 1`,
        [contactId,staffText,messageId]
      );
      const recorded=proof.rows?.[0];
      if(!recorded?.id)return null;
      recordedProof=recorded;
      if(terseSlot&&isTerseBookingCorroborated(
        staffText,terseSlot,recorded.prior_turns,recorded.created_at)){
        appointmentAt=terseSlot;
      } else if(contextualCandidate &&
        (appointmentAt=isContextualStaffBookingConfirmed(
          staffText,recorded.prior_turns,recorded.created_at,now()))){
        // Exact customer slot + prior staff offer + current staff confirmation.
      } else {
        // Staff explicitly confirmed a visit but the exact slot lacks enough
        // corroboration. Keep sales paused even if booking-ready hours cannot
        // yet validate the full preference. This never creates a CRM booking.
        if(config.businessType==="tcm_clinic"&&(contextualCandidate||terseSlot&&/^(?:confirm|comfirm)(?:ed)?\s+(?:appointment|booking)\b/iu.test(String(staffText||"").trim()))){
          await persistStaffHold(true,recorded.id);
          if(neutro&&terseSlot)await persistStaffHold(true,recorded.id,terseSlot);
        }
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
      if(neutro){
        const verified=verifiedStaffSlot(staffText,new Date(recordedProof?.created_at||now()),now(),config.hours);
        // Automatic replacement requires explicit staff confirmation, an
        // independently corroborated exact customer agreement, a provider
        // source and compare-and-set protection against a changed CRM row.
        if(verified===appointmentAt&&recordedProof&&
          /^(?:confirm(?:ed)?|comfirm(?:ed)?)\s+(?:appointment|booking)\b/iu.test(String(staffText||"").trim())&&
          isTerseBookingCorroborated(staffText,appointmentAt,recordedProof.prior_turns,recordedProof.created_at)){
          const changed=await pipeline.updateLead(lead.id,{appointmentStatus:"set",appointmentAt},"Verified staff reschedule",{
            expectedBookingRecovery:{contactId,staffMessageId:recordedProof.id,staffText,latestMessageId:recordedProof.id,
              updatedAt:lead.updated_at,expectedAppointmentAt:lead.appointment_at}});
          if(changed)return changed;
        }
        if(verified)await persistStaffHold(true,recordedProof?.id||messageId,verified);
      }
      return null;
    }
    // For a new TCM booking, require a future slot inside configured hours.
    if(config.businessType==="tcm_clinic"&&config.hours?.weekly){
      const instant=Date.parse(appointmentAt),local=new Date(instant+8*3600_000);
      const day=["sunday","monday","tuesday","wednesday","thursday","friday","saturday"][local.getUTCDay()];
      const hours=config.hours.weekly[day];
      const clock=String(local.getUTCHours()).padStart(2,"0")+":"+String(local.getUTCMinutes()).padStart(2,"0");
      if(!Number.isFinite(instant)||instant<now().getTime()||!hours||!/^\d{2}:\d{2}$/u.test(hours.open)||!/^\d{2}:\d{2}$/u.test(hours.close)||clock<hours.open||clock>=hours.close){
        await persistStaffHold(true);
        return null;
      }
    }
    // Existing updateLead handles validation, stage transition, booking alert
    // cleanup and the follow-up suppression for genuinely confirmed bookings.
    return pipeline.updateLead(lead.id, { appointmentStatus: "set", appointmentAt }, "Staff chat confirmation");
  };
}
// AI interpretation can recover a missed SALES hold, never independently
// set or replace a CRM appointment. Persist only authenticated current proof.
async function recordModelConfirmationHold(contactId,inboundId,evidence,{database=pool}={}){
  if(evidence?.kind!=="confirmed"||![contactId,inboundId,evidence.id].every(id=>Number.isSafeInteger(Number(id))&&Number(id)>0)||
    typeof evidence.text!=="string"||!evidence.text.trim())return false;
  const client=await database.connect();
  try{
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(${CONVERSATION_LOCK_NAMESPACE}, $1::integer)`,[contactId]);
    const result=await client.query(MODEL_CONFIRMATION_HOLD_SQL,[contactId,evidence.id,evidence.text,inboundId]);
    await client.query("COMMIT");
    if(result.rows?.length)realtimeEvents.publish("conversation_changed",{contactId,reason:"booking_confirmation_pending"});
    return Boolean(result.rows?.length);
  }catch(error){
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  }finally{client.release();}
}
const recordStaffConfirmedBooking = createStaffBookingConfirmationService();
module.exports = {
  verifiedStaffSlot,
  parseStaffConfirmedSlot,
  parseTerseStaffConfirmedSlot,
  parseNaturalStaffConfirmedSlot,
  isContextualStaffBookingConfirmed,
  isTerseBookingCorroborated,
  isStaffVisitAcknowledgement,
  isProactiveAppointmentReminder,
  createStaffBookingConfirmationService,
  recordStaffConfirmedBooking,
  recordModelConfirmationHold,
};
