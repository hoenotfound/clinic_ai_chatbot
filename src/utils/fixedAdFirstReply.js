"use strict";

// Only bypass model generation for a new, clearly standard Meta-ad enquiry.
// Ad metadata verifies the treatment; it never turns a substantive question
// into a scripted reply. No model output or old CRM interest is trusted here.
const {
  hasCustomerPriceEnquiry,
  hasExplicitPackageOptionsRequest,
  isContextualAdServiceEnquiry,
} = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");

const MAX_AD_CONTEXT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PREFILL_MAX_LENGTH = 240;

// A user may type an interest statement and append a real question or a visit
// preference without a question mark. Such messages must reach normal AI.
// Keep these exclusions narrower than the clinical/price detectors that are
// checked separately. Future promotional-consent wording is intentionally
// NOT a current promotion enquiry.
const SUBSTANTIVE_OR_BOOKING_INTENT =
  /(?:可是|不过|不過|但是|因为|因為|怎么办|怎麼辦|怎么|怎麼|如何|多久|几次|幾次|多少|是否|怀孕|懷孕|产后|產後|副作用|安全吗|安全嗎|疼痛|预约|預約|约时间|約時間|几点|幾點|明天|后天|後天|今天|今晚|早上|下午|晚上|周末|週末|星期[一二三四五六日天]|礼拜[一二三四五六日天]|禮拜[一二三四五六日天]|\b(?:but|however|how|why|what|when|where|whether|pain|pregnan(?:t|cy)|book(?:ing)?|appt|appointment|reserve|available|availability|slot|today|tomorrow|tonight|morning|afternoon|evening|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|refund|schedule|reschedul(?:e|ing)|esok|lusa|pagi|petang|malam|minggu|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad|janji\s*temu|temujanji|pukul|jam\s*\d{1,2})\b|\b(?:at|around)\s*\d{1,2}(?::\d{2})?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b)/iu;

function isStandardAdPrefill(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text || text.length > PREFILL_MAX_LENGTH) return false;
  if (isContextualAdServiceEnquiry(text)) return true;
  // Remove ONLY the common leading greeting. Real questions and arbitrary
  // trailing text do not qualify just because a prefill starts the message.
  const body = text.replace(/^(?:(?:hi|hello|hey)\b|你好|嗨|哈咯)[\s~～,，.!！。]*/iu, "")
    .replace(/[\s。.!！～]+$/u, "").trim();
  if (/[?？\n\r]/u.test(body) || SUBSTANTIVE_OR_BOOKING_INTENT.test(body)) return false;
  // A negated Chinese interest phrase still ENDS with "有兴趣"/"感兴趣".
  // Never treat a polite rejection as consent to a sales introduction.
  if (/(?:不|没|沒|没有|沒有|无|無|并不|並不).{0,8}(?:感兴趣|感興趣|有兴趣|有興趣|兴趣|興趣)/u.test(body) ||
      /\b(?:not\s+(?:really\s+)?interested|no\s+longer\s+interested|changed\s+my\s+mind|tak\s+jadi|tak\s+nak|tidak\s+mahu|batal)\b/iu.test(body)) return false;
  const chineseInterest = /^(?:我)?(?:对|對)(?:你们|你們|贵店|貴店)?\s*.{2,90}?(?:有兴趣|有興趣|感兴趣|感興趣)(?:[，,、\s]*(?:可以|请|請)(?:跟[进進]我|联[系繫]我)(?:[，,、\s]*有(?:优惠|優惠)也(?:发|發)我看看)?)?$/u;
  const english = body.match(/^(?:i(?:'m| am) interested in|i(?:'d| would) like to (?:know|learn) more about)\s+(.{2,100})$/iu);
  const malay = body.match(/^(?:saya|sy)\s+(?:berminat(?:\s+dengan)?|nak\s+tahu\s+tentang|mahu\s+tahu\s+tentang)\s+(.{2,100})$/iu);
  // A subject containing a second request is not a simple interest prefill.
  // In particular, the loose English/Malay prefixes above are not permission
  // to ignore the customer's substantive free-text continuation.
  const englishSubject = english?.[1] || "";
  const malaySubject = malay?.[1] || "";
  const englishIsSimple = Boolean(english) &&
    !/[;,]/u.test(englishSubject) &&
    !/\b(?:and|but|because|also|would|could|can|does|do|is\s+it|are\s+there|have|has|want|need|tell|explain|please|whether|if|for\s+next|next\s+(?:week|month)|this\s+(?:week|month)|after\s+work)\b/iu.test(englishSubject);
  const malayIsSimple = Boolean(malay) &&
    !/[;,]/u.test(malaySubject) &&
    !/\b(?:dan|juga|tapi|tetapi|sebab|kerana|nak|mahu|boleh|berapa|bagaimana|kenapa|mengapa|pernah|sudah|dah|ada|macam|kalau|ingin|minta|bolehkah|untuk\s+esok)\b/iu.test(malaySubject);
  return chineseInterest.test(body) || englishIsSimple || malayIsSimple;
}

function resolveFixedAdFirstReply({
  config,
  isFirstMessage,
  conversationHistory,
  customerText,
  language,
  metaAdContext,
  metaAdCreativeService,
  keywordReason,
  hasStaffHandoff = false,
  hasExistingBooking = false,
  isTextMessage = true,
  services = [],
  serviceAliases = [],
  now = Date.now(),
  onSkip = null,
} = {}) {
  const skip = (reason) => {
    if (config?.enabled === true && typeof onSkip === "function") onSkip(reason);
    return null;
  };
  if (config?.enabled !== true || isFirstMessage !== true ||
      !Array.isArray(conversationHistory) || conversationHistory.length !== 1 ||
      conversationHistory[0]?.role !== "user" || keywordReason || hasStaffHandoff ||
      hasExistingBooking || !isTextMessage) {
    return skip("not_first_eligible_text");
  }
  const replies = Array.isArray(config.replies) ? config.replies : [];
  const adTimestamp = Date.parse(metaAdContext?.attributedAt || "");
  if (!Number.isFinite(adTimestamp) || adTimestamp > now + 60_000 ||
      now - adTimestamp > MAX_AD_CONTEXT_AGE_MS) return skip("missing_or_stale_attribution");
  const treatment = String(metaAdContext?.serviceHint || "").trim();
  if (!treatment || !services.some((item) => item?.name === treatment))
    return skip("no_unique_configured_ad_service");
  if (metaAdCreativeService && metaAdCreativeService !== treatment)
    return skip("creative_service_mismatch");
  if (!isStandardAdPrefill(customerText) ||
      hasCustomerPriceEnquiry(customerText) ||
      hasExplicitPackageOptionsRequest(customerText) ||
      hasClinicalMediaRisk(customerText)) return skip("substantive_or_unsafe_message");

  const messageTreatment = safeServiceFromCustomer(customerText, services, serviceAliases)?.name;
  if (messageTreatment && messageTreatment !== treatment) return skip("customer_service_mismatch");
  // The message must either be the narrowly recognised generic ad enquiry,
  // or it must itself name the advertised service. Do not interpret a specific
  // unknown treatment as permission to send the ad's scripted answer.
  const contextual = isContextualAdServiceEnquiry(customerText);
  if (contextual && metaAdCreativeService !== treatment)
    return skip("generic_enquiry_without_verified_creative");
  if (!contextual && messageTreatment !== treatment)
    return skip("unverified_customer_treatment");

  const matching = replies.filter((item) => item?.service === treatment);
  if (matching.length !== 1) return skip("missing_or_duplicate_reply");
  const locale = String(language || "").toLowerCase().startsWith("zh") ? "zh" :
    String(language || "").toLowerCase().startsWith("ms") ? "ms" : "en";
  // No cross-language fallback: using AI is better than an unintended language.
  const reply = matching[0]?.translations?.[locale];
  if (typeof reply !== "string" || !reply.trim() || reply.length > 1200)
    return skip("no_localized_reply");
  return {
    reply: reply.trim(),
    treatment,
    // The pattern itself proves a current treatment enquiry, even where the
    // shared legacy keyword list does not contain this clinic's service name.
    serviceQuery: true,
    serviceQuerySource: contextual ? "meta_ad" : "customer_message",
  };
}

module.exports = { resolveFixedAdFirstReply, isStandardAdPrefill };
