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
const { matchingMetaAdCreativeServices } = require("../services/metaAdReplyContextService");

const MAX_AD_CONTEXT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PREFILL_MAX_LENGTH = 240;

// A user may type an interest statement and append a real question or a visit
// preference without a question mark. Such messages must reach normal AI.
// Keep these exclusions narrower than the clinical/price detectors that are
// checked separately. Future promotional-consent wording is intentionally
// NOT a current promotion enquiry.
const SUBSTANTIVE_OR_BOOKING_INTENT =
  /(?:可是|不过|不過|但是|因为|因為|怎么办|怎麼辦|怎么|怎麼|如何|多久|几次|幾次|多少|是否|怀孕|懷孕|产后|產後|副作用|安全吗|安全嗎|疼痛|预约|預約|约时间|約時間|几点|幾點|明天|后天|後天|今天|今晚|早上|下午|晚上|周末|週末|星期[一二三四五六日天]|礼拜[一二三四五六日天]|禮拜[一二三四五六日天]|\b(?:but|however|how|why|what|when|where|whether|pain|pregnan(?:t|cy)|book(?:ing)?|appt|appointment|reserve|available|availability|slot|today|tomorrow|tonight|morning|afternoon|evening|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday|refund|schedule|reschedul(?:e|ing)|esok|lusa|pagi|petang|malam|minggu|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad|janji\s*temu|temujanji|pukul|jam\s*\d{1,2})\b|\b(?:at|around)\s*\d{1,2}(?::\d{2})?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b)/iu;

// Remove only recognised FUTURE-contact permission, not a request for
// prices, packages or a promotion now. Meta prefills sometimes end in emoji.
const FUTURE_CONTACT_SUFFIX = /[，,、]\s*(?:可以\s*(?:WhatsApp\s*)?跟[进進]我(?:和(?:发|發)(?:相关|相關)?(?:优惠|優惠))?(?:[，,]\s*有(?:优惠|優惠)也(?:发|發)我看看)?|(?:请|請)\s*(?:联[系繫]我|跟[进進]我)(?:[，,]\s*有(?:优惠|優惠)也(?:发|發)我看看)?|有(?:后续|後續)配套和(?:优惠|優惠)可以\s*WhatsApp\s*(?:发|發)我)$/iu;
const EXTRA_QUESTION = /(?:是不是|会不会|會不會|能不能|可不可以|能否|适合|適合|有没有|有沒有|有效|有用|能治|治好|漏尿|怎[样樣]|请问|請問|多少钱|多少錢|价[格錢钱]|几钱|幾錢|配套(?:有什么|有什麼|哪些)|(?:价格|價錢|费用|費用)|[?？]|\b(?:please\s+(?:tell|explain|send)|can\s+i|could\s+i|is\s+it|does\s+it|how\s+long|how\s+much|any\s+(?:offers?|promos?|packages?))\b)/iu;

function standardPrefillInterestText(value) {
  const raw = String(value || "").normalize("NFKC").trim();
  // Strip *trailing* emoji only. Interior emoji, arbitrary edits or extra
  // customer requests do not become allowed just by resembling a prefill.
  const text = raw.replace(/[\s~～.!！。\uFE0F\u200D\u2600-\u27BF\u{1F300}-\u{1FAFF}]+$/gu, "").trim();
  return text.replace(FUTURE_CONTACT_SUFFIX, "").trim();
}

// A fixed reply may replace Gemini only if the ENTIRE Chinese subject is a
// configured treatment name or alias. A substring match ("骨盆调理" inside
// "骨盆调理需要准备什么") would silently ignore a real customer question.
function isExactConfiguredTreatmentSubject(value, {
  services = [], serviceAliases = [], businessName = "",
} = {}) {
  let subject = String(value || "").normalize("NFKC").trim();
  const name = String(businessName || "").normalize("NFKC").trim();
  const brandOptions = [...new Set([
    name,
    name.replace(/\s+(?:centre|center|clinic)$/iu, "").trim(),
  ].filter(Boolean))].sort((a, b) => b.length - a.length);
  for (const brand of brandOptions) {
    if (subject.toLowerCase().startsWith(brand.toLowerCase() + " ")) {
      subject = subject.slice(brand.length).trim();
      break;
    }
  }
  // Meta's suggested enquiry sometimes puts brackets around the service:
  // "我想了解【3D小颜术】疗程！".
  subject = subject.replace(/^【([^【】]+)】(?=(?:的)?(?:疗程|療程|护理|護理|项目|項目|服务|服務)?$)/u, "$1");
  const withoutType = subject.replace(/(?:的)?(?:疗程|療程|护理|護理|项目|項目|服务|服務)$/u, "").trim();
  const compact = (text) => String(text || "").normalize("NFKC")
    .toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const candidateKeys = new Set([compact(subject), compact(withoutType)].filter(Boolean));
  const namedService = safeServiceFromCustomer(subject, services, serviceAliases);
  if (!namedService) return false;
  const labels = [
    namedService.name,
    ...(Array.isArray(serviceAliases) ? serviceAliases : [])
      .filter(item => item?.officialService === namedService.name)
      .flatMap(item => String(item.alias || "").split(/[,|;，、]/u)),
    ...(namedService.name === "骨盆调理"
      ? ["盆骨", "盆骨调整", "盆骨矫正", "盆骨调理"] : []),
  ];
  return labels.some(label => compact(label).length >= 2 &&
    candidateKeys.has(compact(label)));

}

function isStandardAdPrefill(value, serviceContext = {}) {
  const raw = String(value || "").normalize("NFKC").trim();
  if (!raw || raw.length > PREFILL_MAX_LENGTH) return false;
  if (isContextualAdServiceEnquiry(raw)) return true;
  const interest = standardPrefillInterestText(raw);
  const body = interest
    .replace(/^(?:(?:hi|hello|hey|hai)\b|你好|您好|嗨|哈咯)[\s~～,，.!！。]*/iu, "")
    .replace(/[\s。.!！～]+$/u, "").trim();
  if (!body || /[?？\n\r;,；]/u.test(body) ||
      SUBSTANTIVE_OR_BOOKING_INTENT.test(body) || EXTRA_QUESTION.test(body)) return false;
  if (/(?:不|没|沒|没有|沒有|无|無|并不|並不).{0,8}(?:感兴趣|感興趣|有兴趣|有興趣|兴趣|興趣)/u.test(body) ||
      /\b(?:not\s+(?:really\s+)?interested|not\s+really|not\s+anymore|no\s+longer\s+interested|actually\s+no|changed\s+my\s+mind|tak\s+jadi|tak\s+nak|tidak\s+mahu|batal)\b/iu.test(body)) return false;
  // Match the entire named subject, not arbitrary appended customer text.
  // Keep the grammar broad enough for genuine configured names and prefills,
  // but let Gemini handle any unrecognized wording or extra requirements.
  const chineseInterest = body.match(/^(?:我)?(?:对|對)(?:你们|你們|贵店|貴店)?\s*(.{2,90}?)(?:有兴趣|有興趣|感兴趣|感興趣)$/u);
  const chineseKnow = body.match(/^(?:我)?(?:想|要|希望)(?:了解|知道|咨询|諮詢)(?:一下)?\s*(?:你们|你們|贵店|貴店)?\s*([^,，、?？\n\r]{2,110})$/u);
  const english = body.match(/^(?:i(?:'m| am) interested in|i(?:'d| would) like to (?:know|learn) more about)\s+(.{2,100})$/iu);
  const malay = body.match(/^(?:saya|sy)\s+(?:berminat(?:\s+dengan)?|nak\s+tahu\s+tentang|mahu\s+tahu\s+tentang)\s+(.{2,100})$/iu);
  const englishSubject = english?.[1] || "";
  const malaySubject = malay?.[1] || "";
  const englishIsSimple = Boolean(english) &&
    !/[;,]/u.test(englishSubject) &&
    !/\b(?:and|but|because|also|would|could|can|does|do|is\s+it|are\s+there|have|has|want|need|tell|explain|please|whether|if|for\s+next|next\s+(?:week|month)|this\s+(?:week|month)|after\s+work)\b/iu.test(englishSubject);
  const malayIsSimple = Boolean(malay) &&
    !/[;,]/u.test(malaySubject) &&
    !/\b(?:dan|juga|tapi|tetapi|sebab|kerana|nak|mahu|boleh|berapa|bagaimana|kenapa|mengapa|pernah|sudah|dah|ada|macam|kalau|ingin|minta|bolehkah|untuk\s+esok)\b/iu.test(malaySubject);
  return (Boolean(chineseInterest) &&
      isExactConfiguredTreatmentSubject(chineseInterest[1], serviceContext)) ||
    (Boolean(chineseKnow) &&
      isExactConfiguredTreatmentSubject(chineseKnow[1], serviceContext)) ||
    englishIsSimple || malayIsSimple;
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
  businessName = "",
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
  if (!isStandardAdPrefill(customerText, { services, serviceAliases, businessName }) ||
      hasCustomerPriceEnquiry(standardPrefillInterestText(customerText)) ||
      hasExplicitPackageOptionsRequest(standardPrefillInterestText(customerText)) ||
      hasClinicalMediaRisk(customerText)) return skip("substantive_or_unsafe_message");

  const messageTreatment = safeServiceFromCustomer(customerText, services, serviceAliases)?.name || null;
  const contextual = isContextualAdServiceEnquiry(customerText);
  const creativeMatches = matchingMetaAdCreativeServices(
    metaAdContext, services, serviceAliases
  );
  if (metaAdCreativeService && !creativeMatches.includes(metaAdCreativeService))
    return skip("creative_service_mismatch");

  let treatment = null;
  if (contextual) {
    // Generic "tell me more" MUST still have one independently verified
    // treatment from the actual creative, never a guessed ad name or CRM tag.
    if (!metaAdCreativeService || !creativeMatches.includes(metaAdCreativeService))
      return skip("generic_enquiry_without_verified_creative");
    treatment = metaAdCreativeService;
  } else {
    if (!messageTreatment) return skip("unverified_customer_treatment");
    // A customer can clearly ask about pelvis even when the creative also
    // mentions postpartum care and general body alignment. Only accept the
    // service if that SAME creative explicitly references it. Never override
    // a conflicting creative with a CRM guess.
    if (creativeMatches.length > 0) {
      if (!creativeMatches.includes(messageTreatment))
        return skip("customer_service_mismatch");
      treatment = messageTreatment;
    } else if (metaAdContext?.serviceHint === messageTreatment &&
               !metaAdCreativeService) {
      // Retain the existing narrow ad-name-only fallback when creative names
      // no configured treatment. The customer still explicitly names it.
      treatment = messageTreatment;
    } else {
      return skip("no_unique_configured_ad_service");
    }
  }
  if (!services.some(item => item?.name === treatment))
    return skip("no_unique_configured_ad_service");

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
