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
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");

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

// A short confirmation of a price we actually quoted is different from a new
// treatment selection. Resolve it only against a recent, staff-free customer
// session with a separately verified treatment, current active price and an
// earlier assistant quote of that exact price. The ad/CRM label cannot supply
// the missing treatment.
const PRIOR_QUOTED_SESSION_PRICE = /^(?:so\s+|is\s+it\s+)?(?:RM|MYR)\s*([1-9]\d{1,4})\s*(?:(?:for|per|is\s+for)\s*(?:one|1|a)\s*(?:time|session|treatment|visit)|(?:是|就|只需)?\s*(?:一|1)次(?:护理|護理|疗程|療程)?)\s*(?:only|right|correct|ya|ah|吗|嗎|呢)?[\s?？。!.！]*$/iu;
const PRICE_TOPIC_CHANGE = /(?:换个|換個|另外|不要|不想|不考虑|不考慮|not\s+interested|instead|another\s+treatment|different\s+treatment|stop|unsubscribe|退订|退訂)/iu;

// An explicit "Package?" is a request to see the options NOW, not
// consent to future marketing. Require a fresh customer-authored service name
// in the same verified session and a reply explaining that very service.
// A standalone ad name, assistant suggestion or old staff message is not enough.
function resolveDirectCustomerPackageRequest({
  customerText, conversationHistory, services, serviceAliases, promotions,
} = {}) {
  const text = String(customerText || "").trim();
  if (!/^(?:packages?|pakej|配套|套餐)[\s?？。!.！]*$/iu.test(text)) return null;
  const turns = Array.isArray(conversationHistory) ? conversationHistory : [];
  const before = turns.slice(0, -1);
  const candidates = serviceCandidates(services, serviceAliases);
  const customerTurns = before
    .map((turn, index) => ({ turn, index }))
    .filter(({ turn }) => turn?.role === "user");
  if (customerTurns.length !== 1) return null;
  const { turn, index } = customerTurns[0];
  const selected = pricingMessageText(turn).trim();
  const mentions = [...new Set(findServicesInText(selected, candidates))];
  const service = safeServiceFromCustomer(selected, services, serviceAliases);
  if (!service || mentions.length !== 1 || mentions[0] !== service.name ||
      PRICE_TOPIC_CHANGE.test(selected) ||
      !/(?:有兴趣|有興趣|想了解|想知道|想问|想問|感兴趣|感興趣|interested|enquir|inquir|berminat|nak\s+tahu)/iu.test(selected)) return null;
  const responses = before.slice(index + 1);
  if (!responses.length || responses.length > 4 ||
      responses.some(item => item?.role !== "assistant" || isVerifiedStaffTurn(item)) ||
      !responses.some(item => pricingMessageText(item).includes(service.name) ||
        (service.name === "骨盆调理" && pricingMessageText(item).includes("骨盆")))) return null;
  const prices = verifiedPricesForService(service.name, promotions, text, turns);
  if (!prices?.length) return null;
  return Object.freeze({
    source: "direct_customer_package_request", treatment: service.name,
    type: "price", prices, clarifiedPriceService: null,
  });
}

function resolvePreviouslyQuotedSessionPrice({
  customerText, conversationHistory, services, serviceAliases, promotions,
} = {}) {
  const found = PRIOR_QUOTED_SESSION_PRICE.exec(String(customerText || "").trim());
  if (!found) return null;
  const amount = Number(found[1]);
  const turns = Array.isArray(conversationHistory) ? conversationHistory : [];
  const before = turns.slice(0, -1);
  const candidates = serviceCandidates(services, serviceAliases);
  let service = null, selectedAt = -1;

  for (let i = before.length - 1; i >= 0; i--) {
    if (before[i]?.role !== "user") continue;
    const customer = pricingMessageText(before[i]).trim();
    if (!customer || PRICE_TOPIC_CHANGE.test(customer)) return null;
    const mentions = [...new Set(findServicesInText(customer, candidates))];
    if (mentions.length > 1) return null;
    if (!mentions.length) continue;
    service = safeServiceFromCustomer(customer, services, serviceAliases);
    if (!service || service.name !== mentions[0]) return null;
    selectedAt = i;
    break;
  }
  if (!service) return null;
  const prices = verifiedPricesForService(
    service.name, promotions, customerText, turns
  );
  if (!prices?.length || !prices.some(item => item.price === "RM" + amount)) return null;
  // Only a real, previous automatic quote can establish which amount the
  // customer is confirming. Promo original prices, staff captions and ads
  // are not evidence that the AI quoted this specific current offer.
  const quotePattern = new RegExp("\\b(?:RM|MYR)\\s*" + amount + "\\b", "iu");
  const assistantQuote = before.slice(selectedAt + 1).some(turn =>
    turn?.role === "assistant" && !isVerifiedStaffTurn(turn) &&
    pricingMessageText(turn).includes(service.name) &&
    quotePattern.test(pricingMessageText(turn))
  );
  if (!assistantQuote) return null;
  return Object.freeze({
    source: "confirmed_prior_quote", treatment: service.name,
    type: "price", prices, clarifiedPriceService: null,
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
  ) || session.some(turn => turn.role === "user" &&
    hasClinicalMediaRisk(pricingMessageText(turn)))) return null;

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
  const packageRequest = resolveDirectCustomerPackageRequest({
    customerText: text, conversationHistory: session, services, serviceAliases,
    promotions,
  });
  if (packageRequest) return packageRequest;

  const quotedPriceConfirmation = resolvePreviouslyQuotedSessionPrice({
    customerText: text, conversationHistory: session, services, serviceAliases,
    promotions,
  });
  if (quotedPriceConfirmation) return quotedPriceConfirmation;
  if (!hasExplicitPriceRequest(text)) return null;

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
  // An ad named 骨盆 cannot overrule a customer's NEW enquiry about an
  // unpriced, unrelated neck/shoulder or fascia service. Such wording is
  // not always a configured service alias, so basic alias matching alone
  // would otherwise treat Ashley's "筋膜放松，肩颈" as a pelvic price request.
  const competingBodyConcern = /(?:筋膜|肩[颈頸膀部]|[颈頸]肩|筋膜枪|筋膜槍|\b(?:myofascial|fascia|neck|shoulder)\b)/iu;
  const pelvicMention = /(?:骨盆|盆骨|\b(?:pelvic|pelvis)\b)/iu;
  if (decision.source === "meta_ad" && decision.treatment === "骨盆调理" &&
      session.some(turn => turn.role === "user" &&
        competingBodyConcern.test(pricingMessageText(turn)) &&
        !pelvicMention.test(pricingMessageText(turn)))) return null;
  // Keep the independently verified treatment and price evidence coupled.
  return shadowVerifiedPrice({
    source: decision.source, treatment: decision.treatment,
    customerText: text, conversationHistory: session, promotions,
    clarifiedPriceService: decision.clarifiedPriceService,
  });
}

module.exports = { resolveShadowPriceException, recentVerifiedPricingSession, resolvePreviouslyQuotedSessionPrice, resolveDirectCustomerPackageRequest };
