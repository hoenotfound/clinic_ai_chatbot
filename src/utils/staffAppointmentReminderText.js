"use strict";
// Recognises staff-managed visits for follow-up holds, never CRM booking dates.
function isProactiveAppointmentReminder(message) {
  // A clearly stated appointment can end with optional aftercare guidance:
  // "If you need to reschedule, let us know." That is not a tentative slot.
  // Only ignore this narrowly defined tail after sentence punctuation.
  const value=String(message||"").trim().replace(
    /[.!。！]\s*if\s+(?:you\s+(?:need\s+to\s+(?:reschedule|change\s+the\s+time)|have\s+(?:any\s+)?questions|cannot\s+make\s+it|can't\s+make\s+it)|anything\s+changes)[\s\S]*$/iu,
    ""
  );
  if(value.length<10||value.length>400||/[?？]/u.test(value))return false;
  // Never turn offers, tentative plans, reschedules, cancelled bookings,
  // birthday greetings or marketing copy into a recorded appointment.
  if(/\b(?:if|unless|please[\s]+confirm|can[\s]+you[\s]+confirm|maybe|perhaps|tentative|possibly|if you|subject to|not confirmed|not booked|unconfirmed|pending|cancel(?:led|ed)?|reschedul(?:e|ed|ing)|availab\w*|would you like|may be|might be|provisional|tbc|to book|to schedule|book now|schedule now|slots? open|slots? left|slots? remaining)\b|(?:可能|如果|请确认|請確認|取消|未确认|未確認|待定|改期|不确定|尚未|有空位|还有空位|預約嗎|预约吗)|(?:belum disahkan|batal|mungkin|slot kosong|nak tempah)/iu.test(value))return false;
  if(/\b(?:promo(?:tion)?|discount|sale|trial price|offer expires|coupon|voucher|complimentary|birthday|promosi|diskaun)\b|(?:限时|限時|優惠|优惠|促销|促銷|折扣|生日)/iu.test(value))return false;
  // Concrete time AND day/date required. "Appointment confirmed" alone,
  // "reminder to book", or an invitation to take a slot is not enough.
  const day=/(?:\b(?:tmr|tomorrow|today|this\s+(?:sat|sun|mon|tue|wed|thu|fri)(?:day)?|next\s+(?:sat|sun|mon|tue|wed|thu|fri)(?:day)?|saturday|sunday|monday|tuesday|wednesday|thursday|friday|esok|sabtu|ahad|isnin|selasa|rabu|khamis|jumaat)\b|(?:明天|后天|後天|星期[一二三四五六日天]|(?:本|下|这|這)周[一二三四五六日天]|(?:本|下|這)週[一二三四五六日天])|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b20\d{2}-\d{1,2}-\d{1,2}\b)/iu.test(value);
  const time=/(?:\b(?:0?[1-9]|1[0-9]|2[0-3])[:.][0-5]\d\s*(?:am|pm|pagi|petang)?\b|\b(?:0?[1-9]|1[0-2])\s*(?:am|pm)\b|(?:上午|下午|早上|晚上|傍晚)\s*\d{1,2}[点點]|[一二三四五六七八九十]\s*[点點](?:半)?|\bpukul\s+\d{1,2}(?:[.:][0-5]\d)?\b)/iu.test(value);
  if(!day||!time)return false;
  return /(?:\bremind(?:er|ing)?\b.{0,24}\b(?:appointment|booking)\b|\b(?:your\s+)?(?:appointment|booking)\b.{0,35}\b(?:confirm(?:ed|ation)?|booked|scheduled|set\s+for|remind(?:er)?|is\s+(?:tmr|tomorrow|on|for|at))\b|\b(?:appointment|booking)\s+(?:reminder|confirmed)\b|\bbooked\s+for\s+(?:(?:this|next)\s+)?(?:sat(?:urday)?|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?)\b|\b(?:confirm(?:ed)?|scheduled)\b.{0,35}\b(?:your\s+)?(?:appointment|booking)\b|\b(?:tmr|tomorrow)\b.{0,30}\bsee\s*(?:u|you)\b|\bsee\s*(?:u|you)\b.{0,24}\b(?:tmr|tomorrow|next|this|mon|tue|wed|thu|fri|sat|sun)\b|(?:预约|預約).{0,25}(?:提醒|已确认|已確認|已安排|明天|后天|後天|星期|週|周|见|見)|(?:明天|后天|後天|星期[一二三四五六日天]).{0,24}[见見]|(?:temujanji|janji\s*temu).{0,45}(?:esok|disahkan|peringatan|diingatkan|sabtu|isnin|jumaat)|(?:peringatan|diingatkan).{0,45}(?:temujanji|janji\s*temu)|\bjumpa\b.{0,20}\b(?:esok|sabtu|isnin|jumaat)\b)/iu.test(value);
}

module.exports={isProactiveAppointmentReminder};
