"use strict";

// The single customer/pricing authorization shared by the text guard,
// verified quote formatter and optional promotional-media selector.
// Shadow's observational AI decision is intentionally NOT authorization:
// only its separately verified exception (or a previously verified numbered
// menu/scoped package continuation) can change the real customer reply.
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const {
  relatedPricingConflict, unpricedRelatedPrimary, configuredServiceMention,
} = require("./relatedServicePolicy");

const MAX_SESSION_AGE_MS = 24 * 60 * 60 * 1000;

// The candidate has already passed its own evidence rules. The related
// treatment guard must inspect the same CURRENT verified conversation, not
// override a fresh customer selection using an unrelated, months-old turn.
// Legacy/untimestamped histories retain their conservative full-history check.
function pricingConflictHistory({ candidate, conversationHistory, services, serviceAliases,
  now = Date.now(),
} = {}) {
  const all = Array.isArray(conversationHistory) ? conversationHistory : [];
  if (!all.length || !Number.isFinite(now)) return all;
  let start = all.length, next = now + 60_000;
  for (let i = all.length - 1; i >= 0; i--) {
    const at = all[i]?.pricingCreatedAtMs;
    if (!Number.isFinite(at) || at < now - MAX_SESSION_AGE_MS ||
        at > next) break;
    start = i;
    next = at;
  }
  if (start === all.length) return all;
  const currentSession = all.slice(start);
  // A timestamped menu has already verified "1" against its exact preceding
  // bot-issued choices. That explicit current choice supersedes the treatment
  // discussed before the newer pricing menu, even inside the same 24h.
  if (candidate?.source === "numbered_price_menu" &&
      currentSession.length >= 3 &&
      currentSession.at(-1)?.role === "user" &&
      currentSession.at(-2)?.role === "assistant" &&
      currentSession.at(-3)?.role === "user") {
    return currentSession.slice(-3);
  }
  // The newest explicitly customer-named approved treatment supersedes older
  // topics. A current new incompatible treatment is never hidden: it is
  // necessarily later in this slice and relatedPricingConflict still checks it.
  for (let i = currentSession.length - 1; i >= 0; i--) {
    if (currentSession[i]?.role !== "user") continue;
    if (configuredServiceMention(currentSession[i].content, services, serviceAliases) ===
        candidate?.treatment) return currentSession.slice(i);
  }
  return currentSession;
}

function resolveApprovedPricingAssessment({
  mode = "off", aiDecision = null, shadowException = null,
  scopedPackageDecision = null, numberedMenuDecision = null,
  customerText = "", conversationHistory = [], services = [],
  serviceAliases = [], resultMedia = [], flagged = false,
  bookingReady = false, keywordReason = null,
  marketingStopQuestion = false, now = Date.now(),
} = {}) {
  const rejected = reason => ({ decision: null, reason });
  if (!["shadow", "enabled"].includes(mode)) return rejected("mode_off");
  if (marketingStopQuestion) return rejected("marketing_opt_out");
  if (flagged || bookingReady || keywordReason) return rejected("review_or_booking");
  if (hasClinicalMediaRisk(customerText)) return rejected("clinical_safety");

  // An observed Shadow AI decision cannot become real authorization.
  const candidate = numberedMenuDecision || scopedPackageDecision ||
    (mode === "enabled" ? aiDecision : shadowException);
  if (!candidate) return rejected("no_verified_candidate");
  if (!["price", "package_options"].includes(candidate.type) ||
      typeof candidate.treatment !== "string" || !candidate.treatment.trim() ||
      !(services || []).some(service => service?.name === candidate.treatment)) {
    return rejected("invalid_treatment_or_intent");
  }
  if (mode !== "enabled" && candidate.type !== "price") {
    return rejected("shadow_package_intent_unverified");
  }

  const prices = Array.isArray(candidate.prices) ? candidate.prices : [];
  const validPrices = prices.length > 0 && prices.length <= 4 &&
    prices.every(item => item && typeof item.name === "string" && item.name.trim() &&
      /^RM[1-9]\d{0,5}$/u.test(String(item.price || ""))) &&
    new Set(prices.map(item => item.name)).size === prices.length;
  const textOnly = mode === "enabled" && prices.length === 0 &&
    /^RM[1-9]\d{0,5}$/u.test(String(candidate.servicePrice || ""));
  if (!validPrices && !textOnly) return rejected("active_price_unverified");

  const currentHistory = pricingConflictHistory({
    candidate, conversationHistory, services, serviceAliases, now,
  });
  if (relatedPricingConflict({
    customerText, treatment: candidate.treatment, conversationHistory: currentHistory,
    services, serviceAliases, resultMedia,
  })) return rejected("related_treatment_conflict");
  if (unpricedRelatedPrimary({
    customerText, conversationHistory: currentHistory,
    services, serviceAliases, resultMedia,
  })) return rejected("unpriced_primary_treatment");

  return {
    decision: Object.freeze({
      ...candidate,
      prices: Object.freeze([...prices]),
    }),
    reason: "approved",
  };
}

function resolveApprovedPricingDecision(options = {}) {
  return resolveApprovedPricingAssessment(options).decision;
}

module.exports = { resolveApprovedPricingDecision, resolveApprovedPricingAssessment, pricingConflictHistory };
