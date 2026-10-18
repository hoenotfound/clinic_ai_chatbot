"use strict";

const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const {
  resolveRecentFirstTreatmentPriceService, isVerifiedStaffTurn,
} = require("./priceFollowUpContext");
const { resolveAiPricingDecision } = require("./aiPricingIntentDecision");
const { verifiedPricesForService } = require("./verifiedPriceReply");

// Shadow stays read-only for normal AI pricing. This helper permits only two
// previously verified, narrowly bounded LEGACY price cases:
// 1) a customer names the first treatment, then asks its price;
// 2) a current Meta-ad hints one configured treatment and the customer asks
//    a short, unambiguous price question before switching topics.
// A CRM label/model treatment is never enough. Price evidence must exist now.
function resolveShadowPriceException({
  customerText, conversationHistory = [], metaAdContext = null,
  services = [], serviceAliases = [], promotions = [],
  complimentaryAssessmentExperienceEnabled = false, now = Date.now(),
} = {}) {
  const text = String(customerText || "").trim();
  if (!text || !hasExplicitPriceRequest(text) || hasClinicalMediaRisk(text) ||
      isComplimentaryAssessmentFeeQuestion(
        text, complimentaryAssessmentExperienceEnabled, conversationHistory
      )) return null;
  const turns = Array.isArray(conversationHistory) ? conversationHistory : [];
  // Pricing can never cross a verified staff conversation boundary.
  if (turns.some(isVerifiedStaffTurn)) return null;
  const first = resolveRecentFirstTreatmentPriceService({
    customerText: text, conversationHistory: turns,
    services, serviceAliases, promotions, now,
  });
  if (first) {
    const prices = verifiedPricesForService(first.name, promotions, text, turns);
    if (prices?.length) return Object.freeze({
      source: "recent_first_customer", treatment: first.name,
      type: "price", prices,
    });
  }
  const adDecision = resolveAiPricingDecision({
    priceQuery: true, packageQuery: false, treatment: null,
    customerText: text, conversationHistory: turns,
    services, serviceAliases, promotions, metaAdContext,
    complimentaryAssessmentExperienceEnabled, now,
  });
  // Never permit the general AI-led decision in Shadow; only the validated
  // Meta origin, checked for age, named service and customer topic by the
  // existing pricing resolver, may act as a narrow legacy exception.
  if (adDecision?.source !== "meta_ad" || adDecision.type !== "price" ||
      !adDecision.prices?.length) return null;
  return Object.freeze({
    source: "meta_ad", treatment: adDecision.treatment,
    type: "price", prices: adDecision.prices,
  });
}

module.exports = { resolveShadowPriceException };
