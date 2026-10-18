"use strict";

const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const {
  resolveRecentFirstTreatmentPriceService,
  resolveContinuedTreatmentPriceService,
  isVerifiedStaffTurn, isRecentPricingThread, pricingMessageText,
} = require("./priceFollowUpContext");
const { resolveClarifiedPriceService } = require("./priceClarificationContext");
const { resolveAiPricingDecision } = require("./aiPricingIntentDecision");
const { verifiedPricesForService } = require("./verifiedPriceReply");

const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Restrict every pricing exception to the current continuously timestamped
// conversation. Old contacts may contain old staff replies; those must not
// contaminate a NEW customer-led session. A staff message *inside* the new
// session still blocks pricing, as does missing/untrusted DB timestamp data.
function recentVerifiedPricingSession(conversationHistory = [], customerText, now = Date.now()) {
  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(turn => turn?.role === "user" || turn?.role === "assistant");
  const current = String(customerText || "").trim();
  if (!turns.length || turns.at(-1).role !== "user" ||
      pricingMessageText(turns.at(-1)).trim() !== current ||
      !Number.isFinite(now)) return null;

  let start = turns.length;
  let later = now + 60_000;
  for (let i = turns.length - 1; i >= 0; i--) {
    const timestamp = turns[i]?.pricingCreatedAtMs;
    if (!Number.isFinite(timestamp) || timestamp < now - SESSION_MAX_AGE_MS ||
        timestamp > later) break;
    later = timestamp;
    start = i;
  }
  const session = turns.slice(start);
  if (!session.length || session[0]?.role !== "user" ||
      session.some(isVerifiedStaffTurn) ||
      !isRecentPricingThread(session, 0, now)) return null;
  return session;
}

function shadowVerifiedPrice({
  source, treatment, customerText, conversationHistory, promotions,
  clarifiedPriceService = null,
}) {
  if (!treatment || !source) return null;
  const prices = verifiedPricesForService(
    treatment, promotions, customerText, conversationHistory,
    { clarifiedPriceService }
  );
  if (!prices?.length) return null;
  return Object.freeze({
    source, treatment, type: "price", prices,
    clarifiedPriceService,
  });
}

// Shadow remains read-only for model-only guesses and normal package intent.
// These exceptions require a new, DB-timestamped customer-led session and
// validated active prices. Old staff activity is not inherited across a fresh
// 24h window. Recent staff/clinical/opt-out handling remains fail-closed.
function resolveShadowPriceException({
  customerText, conversationHistory = [], metaAdContext = null,
  services = [], serviceAliases = [], promotions = [],
  complimentaryAssessmentExperienceEnabled = false, now = Date.now(),
} = {}) {
  const text = String(customerText || "").trim();
  if (!text || hasClinicalMediaRisk(text)) return null;
  const session = recentVerifiedPricingSession(conversationHistory, text, now);
  if (!session || isComplimentaryAssessmentFeeQuestion(
    text, complimentaryAssessmentExperienceEnabled, session
  )) return null;

  // "疗程多少钱" -> bot: "which treatment's price?" -> "盆骨调整".
  // The customer answer inherits only that immediate, independently verified
  // pricing question. Neither an older ad nor a model service guess can grant it.
  const clarification = resolveClarifiedPriceService({
    customerText: text, conversationHistory: session, services, serviceAliases,
  });
  if (clarification &&
      isRecentPricingThread(session, session.length - 3, now)) {
    return shadowVerifiedPrice({
      source: "customer_price_clarification", treatment: clarification,
      customerText: text, conversationHistory: session, promotions,
      clarifiedPriceService: clarification,
    });
  }
  if (!hasExplicitPriceRequest(text)) return null;

  const continued = resolveContinuedTreatmentPriceService({
    customerText: text, conversationHistory: session,
    services, serviceAliases, promotions, now,
  });
  if (continued) {
    const result = shadowVerifiedPrice({
      source: "continued_customer", treatment: continued.name,
      customerText: text, conversationHistory: session, promotions,
    });
    if (result) return result;
  }

  const first = resolveRecentFirstTreatmentPriceService({
    customerText: text, conversationHistory: session,
    services, serviceAliases, promotions, now,
  });
  if (first) {
    const result = shadowVerifiedPrice({
      source: "recent_first_customer", treatment: first.name,
      customerText: text, conversationHistory: session, promotions,
    });
    if (result) return result;
  }

  const decision = resolveAiPricingDecision({
    priceQuery: true, packageQuery: false, treatment: null,
    customerText: text, conversationHistory: session,
    services, serviceAliases, promotions, metaAdContext,
    complimentaryAssessmentExperienceEnabled, now,
  });
  if (!decision || decision.type !== "price" || !decision.prices?.length ||
      !["meta_ad", "current_customer", "recent_customer", "continued_customer"].includes(decision.source)) {
    return null;
  }
  // Keep the independently verified treatment and price evidence coupled.
  return shadowVerifiedPrice({
    source: decision.source, treatment: decision.treatment,
    customerText: text, conversationHistory: session, promotions,
    clarifiedPriceService: decision.clarifiedPriceService,
  });
}

module.exports = { resolveShadowPriceException, recentVerifiedPricingSession };
