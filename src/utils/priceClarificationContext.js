"use strict";

const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");

// A customer's named-treatment answer only carries a price request across
// the *immediately preceding* bot clarification. Do not use an old price
// enquiry, the Meta ad/CRM interest, or the model's inferred treatment.
const CHINESE_PRICE_CLARIFICATION =
  /(?:哪(?:一)?(?:项|項|种|種|个|個)?|什[么麼])[^。\n!?！？]{0,55}(?:价格|價格|价钱|價錢|费用|費用|收费|收費)/u;
const ENGLISH_PRICE_CLARIFICATION =
  /(?:\b(?:which|what)\b[^\n?]{0,90}\b(?:price|cost|fees?|charges?)\b|\b(?:price|cost|fees?|charges?)\b[^\n?]{0,90}\b(?:which|what)\b)/iu;
const MALAY_PRICE_CLARIFICATION =
  /(?:\bharga\b[^\n?]{0,60}\b(?:rawatan|pakej)\b[^\n?]{0,45}\b(?:mana|apa)\b|\b(?:rawatan|pakej)\b[^\n?]{0,60}\bharga\b)/iu;
const DECLINED_OR_NEW_TOPIC =
  /(?:不(?:想|要|用|需要|必).{0,16}(?:价|價|钱|錢|配套|优惠|優惠)|(?:别|別).{0,16}(?:报|報|价|價)|\b(?:no|don't|do not|tak nak|tidak mahu)\b.{0,40}\b(?:price|cost|harga|pakej)\b|(?:换个|換個|改聊|另外想|\binstead\b|\brather\b|\bswitch\b))/iu;

function resolveClarifiedPriceService({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
} = {}) {
  const currentText = String(customerText || "").trim();
  if (!currentText || currentText.length > 90 ||
      DECLINED_OR_NEW_TOPIC.test(currentText)) return null;

  // Preserve media turns when checking consecutive customer messages.
  // Require a strict user -> assistant clarification -> user sequence.
  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter((entry) => entry?.role === "user" || entry?.role === "assistant");
  if (turns.length < 3) return null;
  const [earlier, clarification, current] = turns.slice(-3);
  if (earlier.role !== "user" || clarification.role !== "assistant" ||
      current.role !== "user" ||
      typeof earlier.content !== "string" ||
      typeof clarification.content !== "string" ||
      typeof current.content !== "string" ||
      current.content.trim() !== currentText ||
      !hasExplicitPriceRequest(earlier.content)) return null;

  // Require an actual price clarification question, not an ordinary service
  // or booking question. Staff-authored messages have a verified prefix and
  // must not enable an automatic promotional send through this path.
  const question = clarification.content.trim();
  if (question.startsWith("[Verified STAFF message]") ||
      question.length > 240 ||
      ![CHINESE_PRICE_CLARIFICATION, ENGLISH_PRICE_CLARIFICATION,
        MALAY_PRICE_CLARIFICATION].some((pattern) => pattern.test(question))) {
    return null;
  }

  const service = safeServiceFromCustomer(currentText, services, serviceAliases);
  return service?.name || null;
}

module.exports = { resolveClarifiedPriceService };
