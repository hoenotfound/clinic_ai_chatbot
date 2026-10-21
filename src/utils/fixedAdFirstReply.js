"use strict";

// Only bypass model generation for a new, clearly standard Meta-ad enquiry.
// Ad metadata verifies the treatment; it never turns a substantive question
// into a scripted reply. No model output or old CRM interest is trusted here.
const {
  hasCustomerPriceEnquiry,
  hasExplicitPackageOptionsRequest,
  isContextualAdServiceEnquiry,
  hasCustomerServiceEnquiry,
} = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");

const MAX_AD_CONTEXT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const PREFILL_MAX_LENGTH = 240;

function isStandardAdPrefill(value) {
  const text = String(value || "").normalize("NFKC").trim();
  if (!text || text.length > PREFILL_MAX_LENGTH) return false;
  if (isContextualAdServiceEnquiry(text)) return true;
  // Remove ONLY the common leading greeting. Real questions and arbitrary
  // trailing text do not qualify just because a prefill starts the message.
  const body = text.replace(/^(?:(?:hi|hello|hey)\b|你好|嗨|哈咯)[\s~～,，.!！。]*/iu, "")
    .replace(/[\s。.!！～]+$/u, "").trim();
  if (/[?？\n\r]/u.test(body) ||
      /(?:可是|不过|不過|但是|因为|因為|怎么办|怎麼辦|怎么|怎麼|如何|多久|几次|幾次|多少|是否|怀孕|懷孕|产后|產後|副作用|安全吗|安全嗎|疼痛|\b(?:but|however|how|why|what|when|where|whether|pain|pregnan(?:t|cy)|book|appointment|refund)\b)/iu.test(body)) return false;
  const chineseInterest = /^(?:我)?(?:对|對)(?:你们|你們|贵店|貴店)?\s*.{2,90}?(?:有兴趣|有興趣|感兴趣|感興趣)(?:[，,、\s]*(?:可以|请|請)(?:跟[进進]我|联[系繫]我)(?:[，,、\s]*有(?:优惠|優惠)也(?:发|發)我看看)?)?$/u;
  const english = /^(?:i(?:'m| am) interested in|i(?:'d| would) like to (?:know|learn) more about)\s+.{2,100}?(?:[,.]?\s*(?:please|thanks))?$/iu;
  const malay = /^(?:saya|sy)\s+(?:berminat(?:\s+dengan)?|nak\s+tahu\s+tentang|mahu\s+tahu\s+tentang)\s+.{2,100}$/iu;
  return chineseInterest.test(body) ||
    english.test(body) || malay.test(body);
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
} = {}) {
  if (config?.enabled !== true || isFirstMessage !== true ||
      !Array.isArray(conversationHistory) || conversationHistory.length !== 1 ||
      conversationHistory[0]?.role !== "user" || keywordReason || hasStaffHandoff ||
      hasExistingBooking || !isTextMessage) {
    return null;
  }
  const replies = Array.isArray(config.replies) ? config.replies : [];
  const adTimestamp = Date.parse(metaAdContext?.attributedAt || "");
  if (!Number.isFinite(adTimestamp) || adTimestamp > now + 60_000 ||
      now - adTimestamp > MAX_AD_CONTEXT_AGE_MS) return null;
  const treatment = String(metaAdContext?.serviceHint || "").trim();
  if (!treatment || !services.some((item) => item?.name === treatment)) return null;
  if (metaAdCreativeService && metaAdCreativeService !== treatment) return null;
  if (!isStandardAdPrefill(customerText) ||
      hasCustomerPriceEnquiry(customerText) ||
      hasExplicitPackageOptionsRequest(customerText) ||
      hasClinicalMediaRisk(customerText)) return null;

  const messageTreatment = safeServiceFromCustomer(customerText, services, serviceAliases)?.name;
  if (messageTreatment && messageTreatment !== treatment) return null;
  // The message must either be the narrowly recognised generic ad enquiry,
  // or it must itself name the advertised service. Do not interpret a specific
  // unknown treatment as permission to send the ad's scripted answer.
  const contextual = isContextualAdServiceEnquiry(customerText);
  if (!contextual && messageTreatment !== treatment) return null;

  const matching = replies.filter((item) => item?.service === treatment);
  if (matching.length !== 1) return null;
  const locale = String(language || "").toLowerCase().startsWith("zh") ? "zh" :
    String(language || "").toLowerCase().startsWith("ms") ? "ms" : "en";
  // No cross-language fallback: using AI is better than an unintended language.
  const reply = matching[0]?.translations?.[locale];
  if (typeof reply !== "string" || !reply.trim() || reply.length > 1200) return null;
  return {
    reply: reply.trim(),
    treatment,
    serviceQuery: contextual || hasCustomerServiceEnquiry(customerText),
    serviceQuerySource: contextual ? "meta_ad" : "customer_message",
  };
}

module.exports = { resolveFixedAdFirstReply, isStandardAdPrefill };
