"use strict";

const clinicConfig = require("../config/clinicConfig");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const CHINESE_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff]/gu;
const LATIN_TEXT = /[a-z]/giu;
const MALAY_SIGNALS = /\b(?:saya|anda|kami|awak|boleh|untuk|harga|semak|temujanji|janji|dengan|beritahu|pihak|terima|kasih|rawatan|esok|pagi|petang|mahu|nak)\b/giu;
const ENGLISH_SIGNALS = /\b(?:thanks|thank|you|your|we|will|can|please|check|let|know|appointment|tomorrow|morning|available|have|booked|confirm|confirmed|price|for|would|could|time)\b/giu;
const MALAY_SENTENCE = /\b(?:saya|anda|kami|awak|boleh|untuk|semak|beritahu|terima\s+kasih|nak)\b/iu;
const ENGLISH_SENTENCE = /\b(?:thanks|thank|you|your|we|will|please|check|let|know|appointment|tomorrow|morning|available|would|could)\b/iu;

// Short Chinese acknowledgements are complete replies, not service names.
const CHINESE_ACKNOWLEDGEMENTS = new Set([
  "好", "好的", "好啊", "好的呀", "可以", "可以的", "可以呀",
  "收到", "明白", "了解", "是的", "对", "對", "行", "嗯",
  "谢谢", "謝謝", "不客气", "不客氣", "没问题", "沒問題",
]);

// Rewriting clinical meaning is not safe merely because JSON metadata, amounts
// and time fields remain unchanged. Let staff handle sensitive replies.
const CLINICAL_ADVICE = /\b(?:practitioner|doctor|medical|clinical|eligible|eligibility|suitability|suitable|contraindication|diagnos\w*|cure\w*|heal\w*|guarantee\w*|always\s+works|works\s+for\s+everyone|no\s+(?:side\s+effects?|risks?|pain)|permanent\s+results?|assess(?:ment)?\s+(?:your|the|whether|if)|no\s+need\s+for\s+(?:an?\s+)?assessment)\b|(?:中醫師|中医师|醫生|医生|診斷|诊断|安全|適合|适合|疗效|療效|副作用|保证|保證|根治|一定有效|沒有副作用|没有副作用|需要評估|需要评估|先評估|先评估|看過情況|看过情况)|\b(?:doktor|pengamal|penilaian\s+(?:kesihatan|kesesuaian)|sesuai|selamat|risiko|sembuh|dijamin|pasti\s+berkesan|tiada\s+kesan\s+sampingan)\b/iu;

function clinicalCorrectionRisk(text) {
  const value = String(text || "");
  return hasClinicalMediaRisk(value) || CLINICAL_ADVICE.test(value);
}

function shortChineseAcknowledgement(text) {
  const plain = String(text || "").replace(/[\s\p{P}\p{Extended_Pictographic}\uFE0F\u200D]/gu, "");
  return CHINESE_ACKNOWLEDGEMENTS.has(plain);
}

function protectedNames() {
  return [
    ...(clinicConfig.services || []).flatMap(item => [item?.name]),
    ...(clinicConfig.serviceAliases || []).flatMap(item => [item?.alias, item?.officialService]),
    clinicConfig.businessName,
  ].filter(value => typeof value === "string" &&
    (value.match(CHINESE_TEXT) || []).length >= 3);
}

function removeConfiguredNames(text, names = protectedNames()) {
  let result = String(text || "");
  for (const name of [...new Set(names)].sort((a, b) => b.length - a.length)) {
    const normalizedName = String(name || "").trim();
    if (normalizedName.length < 3) continue;
    const escaped = normalizedName
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\s+/g, "\\s*");
    result = result.replace(new RegExp(escaped, "giu"), " ");
  }
  return result;
}

function clearReplyLanguageMismatch(reply, expectedLanguage, options = {}) {
  if (!["en", "ms", "zh"].includes(expectedLanguage)) return false;
  const text = removeConfiguredNames(reply, options.protectedNames);
  const chineseCount = (text.match(CHINESE_TEXT) || []).length;
  const latinCount = (text.match(LATIN_TEXT) || []).length;
  const malayCount = (text.match(MALAY_SIGNALS) || []).length;
  const englishCount = (text.match(ENGLISH_SIGNALS) || []).length;
  const hasMalayProse = MALAY_SENTENCE.test(text);
  const hasEnglishProse = ENGLISH_SENTENCE.test(text);

  if (expectedLanguage === "zh") {
    // Small English labels and place/service names are natural in Chinese
    // chats. Flag complete Latin replies, not "OK", "3D", or "First Trial".
    return chineseCount === 0 && latinCount >= 12 &&
      ((englishCount >= 2 && hasEnglishProse) ||
       (malayCount >= 2 && hasMalayProse));
  }

  if (shortChineseAcknowledgement(text)) return true;
  if (chineseCount >= 3 && chineseCount > latinCount * 0.35) return true;
  // Only identify high-confidence English/Malay mismatches, not natural
  // Malaysian code-switching. Unknown/short phrasing is left to the model's
  // explicit per-turn language instruction.
  if (expectedLanguage === "en") {
    return malayCount >= 3 && hasMalayProse && malayCount >= englishCount * 1.5;
  }
  return englishCount >= 3 && hasEnglishProse &&
    englishCount >= malayCount * 1.5;
}

function sameBookingFacts(original, replacement) {
  if (original.bookingReady !== replacement.bookingReady) return false;
  const a = original.details || {};
  const b = replacement.details || {};
  const keys = ["branch", "treatment", "appointmentPreference", "projectLocation", "projectSummary", "nextStep"];
  return keys.every(key => (a[key] ?? null) === (b[key] ?? null));
}

function sameIntent(original, candidate) {
  const keys = [
    "outcome", "flagged", "reviewRequired", "reviewType", "bookingReady",
    "serviceQuery", "serviceQuerySource", "priceQuery", "packageQuery", "promotionOption",
  ];
  return keys.every(key => (original[key] ?? null) === (candidate[key] ?? null)) &&
    sameBookingFacts(original, candidate);
}

function quotedAmounts(text) {
  return [...String(text || "").matchAll(/\bRM\s*([\d,]+(?:\.\d{1,2})?)/giu)]
    .map(match => match[1].replace(/,/g, "")).sort();
}

function appointmentConfirmationClaim(text) {
  const value = String(text || "");
  return /(?:your|the)\s+(?:appointment|booking|slot)\s+(?:is|has\s+been)\s+confirm(?:ed)?\b|\b(?:appointment|booking)\s+confirmed\b|\bwe\s+(?:have\s+)?booked\s+(?:you|your)|\bsee\s+you\s+(?:tomorrow|on\s+\w+|then)\b|(?:预约|預約)(?:成功|已确认|已確認)|(?:已经|已經)(?:确定|確定|预约|預約)|(?:temu\s+janji|tempahan)\s+(?:telah\s+)?disahkan/iu.test(value);
}

function correctionPreservesClaims(original, candidate, options = {}) {
  const before = String(original.text || "");
  const after = String(candidate.text || "");
  if (clinicalCorrectionRisk(before) || clinicalCorrectionRisk(after)) return false;
  const originalAmounts = quotedAmounts(before);
  const updatedAmounts = quotedAmounts(after);
  if (JSON.stringify(originalAmounts) !== JSON.stringify(updatedAmounts)) return false;

  // A translated booking acknowledgement must not invent a confirmed slot.
  // An existing CRM confirmation can be discussed in a normal conversation,
  // but cannot be invented by a language-correction request.
  const verified = /^(?:set|visited|booked|confirmed|scheduled)$/iu
    .test(String(options.bookingContext?.status || ""));
  if (!verified && appointmentConfirmationClaim(after)) return false;
  if (!appointmentConfirmationClaim(before) && appointmentConfirmationClaim(after)) return false;

  // Preserve digits in appointment times, prices and service labels.
  const numericTokens = text => (String(text || "").match(/\d+(?:[:.]\d+)?/g) || []).sort();
  return JSON.stringify(numericTokens(before)) === JSON.stringify(numericTokens(after));
}

function bookingAcknowledgement(language) {
  if (language === "ms") {
    return "Baik, saya dah catat masa pilihan anda 😊 Pihak pusat akan semak kekosongan dan sahkan temu janji dengan anda.";
  }
  if (language === "zh") {
    return "好的，已经记录您想预约的时间 😊 我会请门店确认是否有空位，再回复您。";
  }
  return "Thanks, I've noted your preferred time 😊 I'll ask the team to check availability and confirm with you.";
}

function handoffAcknowledgement(language) {
  if (language === "ms") return "Saya akan minta pihak pusat bantu semak perkara ini dan balas kepada anda ya 😊";
  if (language === "zh") return "我会请门店同事帮您确认，再回复您哦 😊";
  return "I'll ask the team to check this and get back to you 😊";
}

function isUsableCorrection(original, candidate, language, options) {
  return candidate && sameIntent(original, candidate) &&
    !clearReplyLanguageMismatch(candidate.text, language, options) &&
    correctionPreservesClaims(original, candidate, options);
}

function staffLanguageHandoff(original, language) {
  return {
    ...original,
    text: handoffAcknowledgement(language),
    flagged: true,
    reviewRequired: false,
    bookingReady: false,
    languageCorrectionFailed: true,
  };
}

// The clinic booking-ready outcome contains staff-facing appointment evidence.
// Do not ask a second generative model to rewrite a scheduling acknowledgement.
// Only replace the customer-facing text with a fixed, unconfirmed acknowledgement,
// preserving the original booking details and eligibility for staff review.
async function correctReplyLanguage(original, history, options, { getReply, parseReply, onCorrectionError } = {}) {
  const language = options?.replyLanguage;
  if (original.flagged ||
      !clearReplyLanguageMismatch(original.text, language, options)) {
    return original;
  }

  if (original.bookingReady) {
    return { ...original, text: bookingAcknowledgement(language) };
  }

  // No second generative request for clinical or suitability conversations.
  // Limit the customer-context check to the latest user turn so a past symptom
  // does not cause an unrelated current administrative reply to be handed off.
  const latestCustomerTurn = Array.isArray(history)
    ? [...history].reverse().find(message => message?.role === "user")?.content
    : null;
  if (clinicalCorrectionRisk(original.text) ||
      clinicalCorrectionRisk(latestCustomerTurn)) {
    return staffLanguageHandoff(original, language);
  }

  try {
    const correction = parseReply(await getReply(history, {
      ...options,
      strictReplyLanguage: true,
      correctionSourceReply: String(original.text || "").slice(0, 2000),
    }));
    if (isUsableCorrection(original, correction, language, options)) {
      return { ...original, text: correction.text };
    }
    if (typeof onCorrectionError === "function") {
      const error = new Error("Language correction failed intent or fact validation.");
      error.code = "AI_LANGUAGE_CORRECTION_UNSAFE";
      onCorrectionError(error);
    }
  } catch (error) {
    if (typeof onCorrectionError === "function") onCorrectionError(error);
  }

  // Unlike information review, a true handoff cannot be silently cleared by
  // later price-review recovery logic. Don't send the wrong-language model
  // draft; keep the initial structured evidence in the staff audit context.
  return staffLanguageHandoff(original, language);
}

module.exports = {
  clearReplyLanguageMismatch,
  correctReplyLanguage,
  sameBookingFacts,
  correctionPreservesClaims,
  bookingAcknowledgement,
  clinicalCorrectionRisk,
};
