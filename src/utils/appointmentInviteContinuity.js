"use strict";

// Only refine an actual Neutro booking invitation. This is conversational
// continuity, not appointment readiness or confirmation authority.
function isNeutroBusiness(config = {}) {
  return config.businessType === "tcm_clinic" &&
    /^Neutro\s+Sense\b/iu.test(String(config.businessName || config.clinicName || ""));
}

const DAY_ZH = /(?:[上下这這本](?:个|個)?(?:星期|周|週|礼拜|禮拜)[一二三四五六日天]|\b\d{1,2}\s*月\s*\d{1,2}\s*[日号號]?\b|\b\d{1,2}\s*[/-]\s*\d{1,2}(?:\s*[/-]\s*\d{2,4})?\b|(?:星期|礼拜|禮拜|周|週)[一二三四五六日天])/u;
const DAY_EN = /\b(?:(?:next|this|coming)\s+)?(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday|rs)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/iu;
const DAY_MS = /\b(?:isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/iu;
const WEEK_ZH = /(?:下|这|這|本)(?:个|個)?(?:星期|周|週|礼拜|禮拜)/u;
const WEEK_EN = /\b(?:next|this|coming)\s+week\b/iu;
const WEEK_MS = /\bminggu\s+(?:depan|ini|hadapan)\b/iu;
const GENERAL_DAY_ZH = /(?:周末|週末|平日|工作日)/u;
const GENERAL_DAY_EN = /\b(?:weekday|weekend)s?\b/iu;
const GENERAL_DAY_MS = /\b(?:hari biasa|hujung minggu)\b/iu;
const CLOCK = /(?:\b(?:[01]?\d|2[0-3])(?:[:.][0-5]\d)?\s*(?:am|pm)\b|(?:早上|上午|下午|晚上|中午|凌晨|傍晚|pagi|petang|malam|tengah hari|morning|afternoon|evening)\b|(?:[01]?\d|2[0-3])\s*(?:点|點|时|時))/iu;
const QUALIFIED_AVAILABILITY = /(?:方便|有空|得空|可以|想|预约|預約|安排|来|來|去|available|free|book|appointment|visit|come|prefer|suits?|works?|boleh|lapang|sesuai|nak|datang|jumpa)/iu;

function customerTiming(customerTexts = []) {
  const texts = (Array.isArray(customerTexts) ? customerTexts : [customerTexts])
    .map(value => typeof value === "string" ? value.trim() : "")
    .filter(Boolean).slice(-5).reverse();
  for (const text of texts) {
    // Past/hypothetical dates and generic questions are not a booking choice.
    const bareDateAnswer = /^(?:(?:下|这|這|本)?(?:个|個)?(?:星期|周|週|礼拜|禮拜)[一二三四五六日天]?|(?:next|this)?\s*(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|(?:isnin|selasa|rabu|khamis|jumaat|sabtu|ahad)|\d{1,2}\s*[\/.-]\s*\d{1,2}(?:\s*[\/.-]\s*\d{2,4})?)(?:\s*(?:[012]?\d(?:[:.][0-5]\d)?\s*(?:am|pm)|[012]?\d\s*(?:点|點)))?\s*[。！!～~]*$/iu.test(text);
    if ((!QUALIFIED_AVAILABILITY.test(text) && !bareDateAnswer) ||
        /(?:上星期|上周|上週|last\s+week|minggu\s+lepas|之前那天)/iu.test(text)) continue;
    const day = DAY_ZH.test(text) || DAY_EN.test(text) || DAY_MS.test(text);
    const time = CLOCK.test(text);
    const week = !day && (WEEK_ZH.test(text) || WEEK_EN.test(text) || WEEK_MS.test(text));
    const generalDay = !day && !week &&
      (GENERAL_DAY_ZH.test(text) || GENERAL_DAY_EN.test(text) || GENERAL_DAY_MS.test(text));
    if (day || week || generalDay) return { day, week, generalDay, time };
  }
  return null;
}

const FINAL_BOOKING_LINE = /(?:你(?:下星期|下周|这星期|這星期|哪一天|那天|比较方便|比較方便|几时|幾時)|(?:which|what)\s+day\b|hari\s+apa\b|(?:hari|pukul)\s+berapa\b)/iu;
const ASSESSMENT_CONTEXT = /(?:1\s*[对對]\s*1|1\s*[-–]?\s*(?:on|to)\s*[-–]?\s*1|one[\s-]on[\s-]one|penilaian|评估|評估|assessment|consultation|konsultasi)/iu;

function adaptedBookingLine({ language, timing }) {
  const lang = String(language || "").toLowerCase();
  if (timing.day && timing.time) {
    if (lang.startsWith("zh")) return "你提到的日期和时段，我可以先帮你向门店确认是否有预约名额，确认后再通知你～";
    if (lang.startsWith("ms")) return "Saya boleh semak hari dan masa yang anda sebut dengan pusat dahulu sebelum sahkan temu janji.";
    return "I can check the day and time you mentioned with the clinic before confirming an appointment.";
  }
  if (timing.day) {
    if (lang.startsWith("zh")) return "你提到的那一天，大概几点比较方便呢？我可以帮你向门店确认时间～";
    if (lang.startsWith("ms")) return "Pada hari yang anda sebut, pukul berapa yang sesuai? Saya boleh semak dengan pusat.";
    return "What time on the day you mentioned would suit you? I can check with the clinic.";
  }
  if (timing.week) {
    if (lang.startsWith("zh")) return "你说的那星期，哪一天比较方便呢？我帮你向门店确认时间～";
    if (lang.startsWith("ms")) return "Dalam minggu yang anda sebut, hari apa yang sesuai? Saya boleh semak dengan pusat.";
    return "Which day in the week you mentioned works best? I'll check with the clinic.";
  }
  if (timing.generalDay) {
    if (lang.startsWith("zh")) return "你提到的平日或周末，哪一天比较方便呢？我可以帮你向门店确认时间～";
    if (lang.startsWith("ms")) return "Hari apa yang sesuai dalam pilihan hari anda tadi? Saya boleh semak dengan pusat.";
    return "Which day within the weekday or weekend preference you mentioned suits you? I'll check with the clinic.";
  }
  return null;
}

function adaptNeutroAppointmentInvitation({
  message, customerTexts = [], language = "zh", businessConfig = {},
} = {}) {
  const original = String(message || "");
  if (!isNeutroBusiness(businessConfig) || !ASSESSMENT_CONTEXT.test(original)) return original;
  const timing = customerTiming(customerTexts);
  if (!timing) return original;
  const replacement = adaptedBookingLine({ language, timing });
  if (!replacement) return original;
  const lines = original.split("\n");
  // Replace only a final scheduling line. Never rewrite service, pricing,
  // consultation facts, links, or a question that is not about booking.
  const lastIndex = lines.length - 1;
  const line = lines[lastIndex].trim();
  if (!FINAL_BOOKING_LINE.test(line) || !/(?:[?？]|确认|確認|check|semak)/iu.test(line)) {
    return original;
  }
  lines[lastIndex] = replacement;
  return lines.join("\n");
}

module.exports = {
  adaptNeutroAppointmentInvitation,
  customerTiming,
  isNeutroBusiness,
};
