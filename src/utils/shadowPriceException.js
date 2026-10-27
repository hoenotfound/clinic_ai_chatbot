"use strict";

const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const {
  resolveRecentFirstTreatmentPriceService,
  resolveContinuedTreatmentPriceService,
  resolveAnsweredConcernPriceService, resolveAnsweredConcernBothContinuation,
  isVerifiedStaffTurn, isRecentPricingThread, pricingMessageText,
} = require("./priceFollowUpContext");
const { resolveClarifiedPriceService } = require("./priceClarificationContext");
const { resolveAiPricingDecision } = require("./aiPricingIntentDecision");
const { resolveIndependentRefusalPriceRequest } = require("./independentRefusalPriceRequest");
const { verifiedPricesForService } = require("./verifiedPriceReply");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const {
  resolveRecentPriceSelection, resolveEstablishedTreatmentPrice,
} = require("./priceConversationRecovery");
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
  const bounded = turns.slice(start);
  // A 20-message AI snapshot can begin in the middle of a previous bot
  // explanation. Never let orphan assistant text authorize a price, but do
  // not discard a NEW customer-led exchange merely because of this truncation.
  // Check staff across the entire timestamped window BEFORE trimming.
  if (!bounded.length || bounded.some(isVerifiedStaffTurn) ||
      !isRecentPricingThread(bounded, 0, now)) return null;
  const firstCustomer = bounded.findIndex(turn => turn.role === "user");
  if (firstCustomer < 0) return null;
  const session = bounded.slice(firstCustomer);
  return session.length && session.at(-1)?.role === "user" ? session : null;
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
const PRIOR_QUOTED_SESSION_PRICE = /^(?:so\s+|is\s+it\s+)?(?:RM|MYR)\s*([1-9]\d{1,4})\s*(?:(?:for|per|is\s+for)\s*(?:one|1|a)\s*(?:time|session|treatment|visit)|(?:是|就|只需)?\s*(?:一|1)次(?:护理|護理|疗程|療程)?)?\s*(?:(?:only|right|correct|ya|ah|吗|嗎)\s*)?[?？!！。.\s]*$/iu;
const PRICE_CONFIRMATION_QUESTION = /[?？]|(?:\b(?:right|correct)\b|吗|嗎)\s*[.!。！]*$/iu;

// Only allow a second, recovery-related question after an explicit, previously
// quoted price confirmation. This does not grant pricing authorization for a
// service change, a different amount, or a general compound request.
// Only recovery-related questions may follow the exact verified RM quote.
// Other prices, treatments, promotions, or image requests never inherit
// the old price authorization.
const RECOVERY_FOLLOWUP_ONLY = new RegExp([
  String.raw`^(?:`,
  String.raw`(?:(?:需要|需不需要|需|有没有|有沒有|是否有|会有|會有|有|要)?\s*`,
  String.raw`(?:修复期|修復期|恢复期|恢復期|康复期|康復期|恢复时间|恢復時間|修复时间|修復時間)`,
  String.raw`\s*(?:吗|嗎|呢|多久|几天|幾天|大概多久|要多久)?)`,
  String.raw`|(?:(?:需要|需|要|是否需要)\s*休息\s*(?:多久|多长|多長|(?:几|幾|多少)\s*天|几日|幾日)?)`,
  String.raw`|(?:(?:is\s+there|any|what\s+about|how\s+long(?:\s+is)?)\s+`,
  String.raw`(?:(?:any|a|the)\s+)?(?:downtime|recovery(?:\s+(?:time|period))?|healing(?:\s+time)?|aftercare))`,
  String.raw`|(?:does\s+(?:it|this|the\s+treatment)\s+(?:have|need|require)\s+`,
  String.raw`(?:(?:any|a|the)\s+)?(?:downtime|recovery(?:\s+(?:time|period))?|healing(?:\s+time)?))`,
  String.raw`|(?:will\s+(?:i|we)\s+(?:need|have)\s+`,
  String.raw`(?:(?:any|some|a)\s+)?(?:time\s+to\s+recover|recovery(?:\s+(?:time|period))?|downtime))`,
  String.raw`|(?:how\s+long\s+does\s+(?:recovery|healing|it|this)\s+(?:take|last))`,
  String.raw`|(?:how\s+many\s+days\s+(?:of|for)\s+(?:recovery|downtime|healing))`,
  String.raw`|(?:ada|perlu|berapa\s+lama)\s+`,
  String.raw`(?:(?:masa|tempoh)\s+)?(?:pemulihan|recovery(?:\s+time)?|downtime)`,
  String.raw`)\s*[?？!.。！]*$`,
].join(""), "iu");

function priorQuoteConfirmationPart(customerText) {
  const text = String(customerText || "").trim();
  const question = text.search(/[?？]/u);
  if (question < 0) return text;
  const after = text.slice(question + 1).trim();
  if (!after) return text;
  if (!RECOVERY_FOLLOWUP_ONLY.test(after)) return null;
  return text.slice(0, question + 1);
}

const PRICE_TOPIC_CHANGE = /(?:换个|換個|另外|不要|不想|不考虑|不考慮|not\s+interested|instead|another\s+treatment|different\s+treatment|stop|unsubscribe|退订|退訂)/iu;

// An explicit "Package?" is a request to see the options NOW, not
// consent to future marketing. Require a fresh customer-authored service name
// in the same verified session and a reply explaining that very service.
// A standalone ad name, assistant suggestion or old staff message is not enough.
function resolveDirectCustomerPackageRequest({
  customerText, conversationHistory, services, serviceAliases, promotions,
  allowOfferEnquiries = false,
} = {}) {
  const text = String(customerText || "").trim();
  // Keep the existing opt-in for package-only enquiries authoritative.
  if (allowOfferEnquiries !== true ||
      !/^(?:packages?|pakej|配套|套餐)[\s?？。!.！]*$/iu.test(text)) return null;
  const turns = Array.isArray(conversationHistory) ? conversationHistory : [];
  const before = turns.slice(0, -1);
  const candidates = serviceCandidates(services, serviceAliases);
  const priorCustomers = before.flatMap((turn, index) =>
    turn?.role === "user" ? [index] : []).slice(-4);
  if (!priorCustomers.length) return null;

  let service = null, selectedIndex = -1;
  for (let pos = priorCustomers.length - 1; pos >= 0; pos--) {
    const index = priorCustomers[pos];
    const source = pricingMessageText(before[index]).trim();
    if (!source || PRICE_TOPIC_CHANGE.test(source)) return null;
    const mentions = [...new Set(findServicesInText(source, candidates))];
    if (mentions.length > 1) return null;
    if (mentions.length) {
      const named = safeServiceFromCustomer(source, services, serviceAliases);
      if (!named || named.name !== mentions[0]) return null;
      if (!/(?:有兴趣|有興趣|想了解|想知道|想问|想問|感兴趣|感興趣|interested|enquir|inquir|berminat|nak\s+tahu|mahu\s+tahu)/iu.test(source))
        return null;
      service = named;
      selectedIndex = index;
      break;
    }
    // A brief follow-up about the same treatment may bridge the selection,
    // but a broad new topic or unrelated request cannot.
    if (!/^(?:有(?:什么|什麼)效果|效果(?:呢|怎么样|怎樣|如何)?|有效(?:吗|嗎|果)?|做(?:一|1)次(?:有(?:什么|什麼)效果)?|(?:多久|多长|多長|会不会痛|會不會痛)|how\s+(?:does\s+it\s+work|long)|(?:what|any)\s+(?:results?|benefits?)|is\s+it\s+effective)[\s?？。!.！]*$/iu.test(source))
      return null;
  }
  if (!service) return null;

  // A bot must have acknowledged the customer's selected service. Otherwise
  // its own advertisement/suggestion might be incorrectly treated as consent.
  const firstNextCustomer = priorCustomers.find(index => index > selectedIndex);
  const responses = before.slice(selectedIndex + 1,
    firstNextCustomer === undefined ? before.length : firstNextCustomer);
  if (!responses.length || responses.length > 4 ||
      responses.some(item => item?.role !== "assistant" ||
        isVerifiedStaffTurn(item) || !pricingMessageText(item).trim()) ||
      !responses.some(item => pricingMessageText(item).includes(service.name) ||
        (service.name === "骨盆调理" && pricingMessageText(item).includes("骨盆"))))
    return null;
  const prices = verifiedPricesForService(service.name, promotions, text, turns);
  if (!prices?.length) return null;
  return Object.freeze({
    source: "direct_customer_package_request", treatment: service.name,
    type: "package_options", prices, clarifiedPriceService: null,
  });
}
function resolvePreviouslyQuotedSessionPrice({
  customerText, conversationHistory, services, serviceAliases, promotions,
} = {}) {
  const confirmation = priorQuoteConfirmationPart(customerText);
  if (!confirmation) return null;
  const found = PRIOR_QUOTED_SESSION_PRICE.exec(confirmation);
  if (!found || !PRICE_CONFIRMATION_QUESTION.test(confirmation)) return null;
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
  const matched = prices?.filter(item => item.price === "RM" + amount) || [];
  // An amount that belongs to multiple packages is ambiguous, never guess.
  if (matched.length !== 1) return null;
  // Only a real, previous automatic quote can establish which amount the
  // customer is confirming. Promo original prices, staff captions and ads
  // are not evidence that the AI quoted this specific current offer.
  const quotePattern = new RegExp("\\b(?:RM|MYR)\\s*" + amount + "\\b", "iu");
  const assistantQuote = before.slice(selectedAt + 1).some(turn => {
    if (turn?.role !== "assistant" || isVerifiedStaffTurn(turn)) return false;
    const message = pricingMessageText(turn);
    if (!message.includes(service.name)) return false;
    if (prices.length === 1) return quotePattern.test(message);
    // For multi-package promotions a different package's original price
    // cannot establish that THIS package was previously quoted.
    const start = message.indexOf(matched[0].name);
    if (start < 0) return false;
    const nextPackageStarts = prices.filter(item => item.name !== matched[0].name)
      .map(item => message.indexOf(item.name, start + matched[0].name.length))
      .filter(index => index >= 0);
    const end = nextPackageStarts.length ? Math.min(...nextPackageStarts) : message.length;
    return quotePattern.test(message.slice(start, end));
  });
  if (!assistantQuote) return null;
  return Object.freeze({
    source: "confirmed_prior_quote", treatment: service.name,
    type: "price", prices: matched, clarifiedPriceService: null,
  });
}

// Shadow remains read-only for model-only guesses and normal package intent.
// These exceptions require a new, DB-timestamped customer-led session and
// validated active prices. Old staff activity is not inherited across a fresh
// 24h window. Recent staff/clinical/opt-out handling remains fail-closed.
function resolveShadowPriceException({
  customerText, conversationHistory = [], metaAdContext = null,
  services = [], serviceAliases = [], promotions = [],
  complimentaryAssessmentExperienceEnabled = false,
  allowOfferEnquiries = false, now = Date.now(),
} = {}) {
  const text = String(customerText || "").trim();
  if (!text || hasClinicalMediaRisk(text)) return null;
  const session = recentVerifiedPricingSession(conversationHistory, text, now);
  if (!session || isComplimentaryAssessmentFeeQuestion(
    text, complimentaryAssessmentExperienceEnabled, session
  ) || session.some(turn => turn.role === "user" &&
    hasClinicalMediaRisk(pricingMessageText(turn)))) return null;

  // A customer may refuse one quotation and ask for a DIFFERENT treatment
  // in one message. Its service comes only from the verified current clause.
  // Handle this before older-session recovery, and keep the original
  // session's staff, safety and trusted timestamp checks intact.
  const mixed = resolveIndependentRefusalPriceRequest({
    customerText: text, services, serviceAliases,
  });
  if (mixed) {
    const scoped = resolveAiPricingDecision({
      priceQuery: true, packageQuery: false, treatment: null,
      customerText: text, conversationHistory: session, services,
      serviceAliases, promotions, metaAdContext,
      complimentaryAssessmentExperienceEnabled, now,
    });
    if (!scoped || scoped.type !== "price" ||
        scoped.treatment !== mixed.treatment ||
        scoped.source !== "current_customer" || !scoped.prices?.length) return null;
    const verified = shadowVerifiedPrice({
      source: "current_customer", treatment: mixed.treatment,
      customerText: mixed.priceText, conversationHistory: session, promotions,
    });
    return verified ? Object.freeze({
      ...verified,
      scopedPriceText: mixed.priceText,
      scopedRefusedTreatment: mixed.refusedTreatment,
    }) : null;
  }

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
  // Recover a service the customer explicitly chose after the bot provided
  // pricing options. This does not treat a model/advertisement as the choice.
  const recentSelection = resolveRecentPriceSelection({
    customerText:text, session, services, serviceAliases, now,
  });
  if (recentSelection) {
    const decision = shadowVerifiedPrice({
      source:"customer_price_selection", treatment:recentSelection.name,
      customerText:text, conversationHistory:session, promotions,
      clarifiedPriceService:recentSelection.name,
    });
    if (decision) return decision;
  }

  const packageRequest = resolveDirectCustomerPackageRequest({
    customerText: text, conversationHistory: session, services, serviceAliases,
    promotions, allowOfferEnquiries,
  });
  if (packageRequest) return packageRequest;

  const quotedPriceConfirmation = resolvePreviouslyQuotedSessionPrice({
    customerText: text, conversationHistory: session, services, serviceAliases,
    promotions,
  });
  if (quotedPriceConfirmation) return quotedPriceConfirmation;
  // After a wrongly repeated "which treatment price?" question, "both"
  // refers to the previously verified service and one unknown second item.
  // Answer the known service only. Do not let an unrelated acquisition ad
  // invent what the second service is.
  const bothContinuation = resolveAnsweredConcernBothContinuation({
    customerText: text, conversationHistory: session,
    services, serviceAliases, now,
  });
  if (bothContinuation) {
    const result = shadowVerifiedPrice({
      source: "customer_concern_both", treatment: bothContinuation.name,
      customerText: text, conversationHistory: session, promotions,
    });
    if (result) return result;
  }
  if (!hasExplicitPriceRequest(text)) return null;

  const concernContinuation = resolveAnsweredConcernPriceService({
    customerText: text, conversationHistory: session,
    services, serviceAliases, now,
  });
  if (concernContinuation) {
    const result = shadowVerifiedPrice({
      source: "customer_concern_continuation", treatment: concernContinuation.name,
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

  // A bounded customer-led discussion can have several normal Q&A turns
  // after the original treatment choice. A direct price question still refers
  // to that verified service, unless staff, a new topic or ambiguity intervened.
  const established = resolveEstablishedTreatmentPrice({
    customerText:text, session, services, serviceAliases, now,
  });
  if (established) {
    const result = shadowVerifiedPrice({
      source:"customer_established_treatment", treatment:established.name,
      customerText:text, conversationHistory:session, promotions,
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
