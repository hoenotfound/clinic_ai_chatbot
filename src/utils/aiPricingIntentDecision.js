"use strict";

// The existing model priceQuery/packageQuery fields classify the customer's
// request. Only customer-authored service evidence and active configured prices
// can authorize customer-facing price quotations or promotional media.
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { stripFutureFollowUpPermission, hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { resolveClarifiedPriceService } = require("./priceClarificationContext");
const { verifiedPricesForService } = require("./verifiedPriceReply");
const { getActivePromotions } = require("./activePromotion");

const RESET = /(?:换个|換個|改聊|另外想|先不聊|不聊这个|不聊這個|其他话题|其他話題|不要这个|不要這個|不想了解|\b(?:instead|rather|switch|different treatment|another treatment|not interested|stop|unsubscribe)\b)/iu;
const REFUSAL = /(?:不要(?:报价|報價|价格|價格|價錢|价钱|优惠|優惠|促销|促銷)|不用(?:报价|報價|价格|價格)|别(?:报|報)价|\b(?:do not|don't|no)\s+(?:send|want|need)\b.{0,35}\b(?:price|promo|offer)\b)/iu;
const STAFF_PREFIX = /^\[Verified STAFF message\]/u;
const UNRELATED = /(?:停车|停車|营业|營業|开门|開門|几点|幾點|在哪|地址|分行|预约|預約|退款|取消|\b(?:parking|hours|location|address|branch|booking|appointment|refund|cancel)\b)/iu;
const BRIDGE = /(?:这个|這個|那个|那個|效果|有效|多久|时间|時間|包括|包含|套餐|配套|护理|護理|疗程|療程|调理|調理|\b(?:this|that|it|results?|effective|duration|long|include|package|session|treatment|details?|pakej|rawatan)\b)/iu;

function verifiedServiceAnchor({
  customerText, conversationHistory, services, serviceAliases, modelTreatment,
}) {
  const current = String(customerText || "").trim();
  const candidates = serviceCandidates(services, serviceAliases);
  const mentions = [...new Set(findServicesInText(current, candidates))];
  const currentService = safeServiceFromCustomer(current, services, serviceAliases);
  if (mentions.length > 1 || (mentions.length && !currentService)) return null;
  if (currentService) {
    return !modelTreatment || modelTreatment === currentService.name
      ? { treatment: currentService.name, source: "current_customer" }
      : null;
  }

  // Never carry a treatment from a CRM label, an ad, or a bot suggestion.
  // Read a maximum of two previous customer turns. An intervening customer
  // turn is permitted only when it clearly refers to the same treatment.
  if (current.length > 115) return null;
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  let currentSkipped = false, customerTurns = 0, bridge = false;
  for (let i = history.length - 1; i >= 0 && customerTurns < 2; i -= 1) {
    const entry = history[i];
    if (entry?.role === "assistant") {
      if (STAFF_PREFIX.test(String(entry.content || "").trim())) return null;
      continue;
    }
    if (entry?.role !== "user") continue;
    const text = String(entry.content || "").trim();
    if (!currentSkipped && text === current) { currentSkipped = true; continue; }
    if (!text || RESET.test(text) || REFUSAL.test(text)) return null;
    customerTurns += 1;
    const found = [...new Set(findServicesInText(text, candidates))];
    const named = safeServiceFromCustomer(text, services, serviceAliases);
    if (found.length > 1 || (found.length && !named)) return null;
    if (named) {
      return !modelTreatment || modelTreatment === named.name
        ? { treatment: named.name, source: "recent_customer" }
        : null;
    }
    if (bridge || UNRELATED.test(text) || !BRIDGE.test(text)) return null;
    bridge = true;
  }
  return null;
}

function resolveAiPricingDecision({
  priceQuery = false, packageQuery = false, treatment = null,
  customerText, conversationHistory = [], services = [],
  serviceAliases = [], promotions = [], allowOfferEnquiries = false,
  complimentaryAssessmentExperienceEnabled = false,
} = {}) {
  const current = String(customerText || "").trim();
  if (!current || RESET.test(current) || REFUSAL.test(current) ||
      hasClinicalMediaRisk(current) ||
      isComplimentaryAssessmentFeeQuestion(
        current, complimentaryAssessmentExperienceEnabled, conversationHistory
      )) return null;

  // Retain the existing explicit-price detector as a narrow fallback when the
  // AI misses a clear price request. It cannot select a service by itself.
  const clarifiedPriceService = resolveClarifiedPriceService({
    customerText: current, conversationHistory, services, serviceAliases,
  });
  const monetary = priceQuery === true || hasExplicitPriceRequest(current) ||
    Boolean(clarifiedPriceService);
  const type = monetary ? "price" :
    packageQuery === true && allowOfferEnquiries ? "package_options" : null;
  if (!type) return null;
  const stripped = stripFutureFollowUpPermission(current);
  if (stripped.hasFuturePermission && !hasExplicitPriceRequest(stripped.text)) return null;

  const anchor = verifiedServiceAnchor({
    customerText: current, conversationHistory, services, serviceAliases,
    modelTreatment: treatment,
  });
  if (!anchor || (clarifiedPriceService &&
      clarifiedPriceService !== anchor.treatment)) return null;

  // A single decision supplies the same package choices and amounts to both
  // the text formatter and the optional media selector. Missing/conflicting
  // prices are recorded as null and must never authorize promo media.
  const prices = verifiedPricesForService(
    anchor.treatment, promotions, current, conversationHistory,
    { clarifiedPriceService, allowTextOnlyOffers: true }
  );
  // Some clients configure prices directly on SERVICES without promotions.
  // Reuse that verified service text only when there is no active offer for
  // this treatment. A conflicting/uncertain active offer must fail closed.
  const activeOffer = getActivePromotions(promotions).some(p => p.linkedService === anchor.treatment);
  const rawServicePrice = !activeOffer
    ? services.find(s => s.name === anchor.treatment)?.priceRange : null;
  const servicePrice = typeof rawServicePrice === "string" &&
    rawServicePrice.trim().length <= 180 &&
    /(?:\b(?:RM|MYR|USD|SGD|EUR|GBP)\s*|[$€£]\s*)\d/iu.test(rawServicePrice)
      ? rawServicePrice.trim() : null;
  return Object.freeze({
    type, treatment: anchor.treatment, source: anchor.source,
    clarifiedPriceService, prices, servicePrice,
  });
}

// Compatibility alias for existing imports in downstream tests.
module.exports = { resolveAiPricingDecision, verifiedServiceAnchor };
