// Customer language is inferred from customer turns, never AI or staff wording.
// This guard runs on the parsed MODEL draft, before existing booking/pricing/
// clinical/media validation. It does not translate or alter trusted clinic data.
const CHINESE_TEXT = /[\u3400-\u4dbf\u4e00-\u9fff]/gu;
const LATIN_TEXT = /[a-z]/giu;

function clearReplyLanguageMismatch(reply, expectedLanguage) {
  const text = String(reply || "").trim();
  if (!text || !["en", "ms", "zh"].includes(expectedLanguage)) return false;
  const chineseCharacters = (text.match(CHINESE_TEXT) || []).length;
  const latinLetters = (text.match(LATIN_TEXT) || []).length;

  if (expectedLanguage === "en" || expectedLanguage === "ms") {
    // An English/Malay reply can legitimately contain Chinese service names.
    // Only catch Chinese-dominant prose, not names embedded in Latin sentences.
    return chineseCharacters >= 4 && chineseCharacters > latinLetters * 0.35;
  }

  // Chinese conversations sometimes quote long English terms. Restrict this
  // case to clear English prose with no Chinese characters at all.
  return chineseCharacters === 0 && latinLetters >= 32 &&
    /\b(?:we|you|your|please|can|could|would|appointment|thank|today|tomorrow|available|price|session)\b/iu.test(text);
}

function sameBookingFacts(original, replacement) {
  if (original.bookingReady !== replacement.bookingReady) return false;
  if (!original.bookingReady) return true;
  const oldDetails = original.details || {};
  const newDetails = replacement.details || {};
  return oldDetails.branch === newDetails.branch &&
    oldDetails.appointmentPreference === newDetails.appointmentPreference &&
    oldDetails.treatment === newDetails.treatment;
}

function isUsableCorrection(original, candidate, language) {
  return candidate && !candidate.flagged &&
    candidate.outcome === original.outcome &&
    !clearReplyLanguageMismatch(candidate.text, language) &&
    sameBookingFacts(original, candidate);
}

// Exactly one corrective model request, only for a high-confidence language
// mismatch. Never revise outcome/intent/booking metadata from the initial
// validated draft: use just the corrected customer-facing text. On failure,
// send no wrong-language draft and raise an existing staff information review.
async function correctReplyLanguage(original, history, options, { getReply, parseReply, onCorrectionError } = {}) {
  const language = options?.replyLanguage;
  if (original.flagged || !clearReplyLanguageMismatch(original.text, language)) {
    return original;
  }

  try {
    const correction = parseReply(await getReply(history, {
      ...options,
      strictReplyLanguage: true,
    }));
    if (isUsableCorrection(original, correction, language)) {
      return { ...original, text: correction.text };
    }
  } catch (error) {
    if (typeof onCorrectionError === "function") onCorrectionError(error);
  }

  return {
    ...original,
    text: "Staff review requested",
    flagged: true,
    reviewRequired: true,
    reviewType: "information",
    bookingReady: false,
    serviceQuery: false,
    serviceQuerySource: null,
    priceQuery: false,
    packageQuery: false,
    details: null,
  };
}

module.exports = {
  clearReplyLanguageMismatch,
  correctReplyLanguage,
  sameBookingFacts,
};
