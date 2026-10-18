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

function resolveApprovedPricingDecision({
  mode = "off", aiDecision = null, shadowException = null,
  scopedPackageDecision = null, numberedMenuDecision = null,
  customerText = "", conversationHistory = [], services = [],
  serviceAliases = [], resultMedia = [], flagged = false,
  bookingReady = false, keywordReason = null,
  marketingStopQuestion = false,
} = {}) {
  // Off is an untouched legacy rollout state for other clients. Its
  // existing menu and promotion paths retain their original gates.
  if (!["shadow", "enabled"].includes(mode) ||
      flagged || bookingReady || keywordReason || marketingStopQuestion ||
      hasClinicalMediaRisk(customerText)) return null;

  // Explicit customer-selected flows are already independently checked for
  // timestamp continuity, staff boundaries and verified active prices.
  // A Shadow-only AI result cannot bypass those checks.
  const candidate = numberedMenuDecision || scopedPackageDecision ||
    (mode === "enabled" ? aiDecision :
      mode === "shadow" ? shadowException : null);
  if (!candidate || !["price", "package_options"].includes(candidate.type) ||
      typeof candidate.treatment !== "string" || !candidate.treatment.trim() ||
      !(services || []).some(service => service?.name === candidate.treatment)) return null;
  if (mode !== "enabled" && candidate.type !== "price") return null;

  const prices = Array.isArray(candidate.prices) ? candidate.prices : [];
  const validPrices = prices.length > 0 && prices.length <= 4 &&
    prices.every(item => item && typeof item.name === "string" && item.name.trim() &&
      /^RM[1-9]\d{0,5}$/u.test(String(item.price || ""))) &&
    new Set(prices.map(item => item.name)).size === prices.length;
  // A verified standing SERVICE price may be text-only (no graphic), but
  // it must never authorize promotional images without approved package prices.
  const textOnly = mode === "enabled" && prices.length === 0 &&
    /^RM[1-9]\d{0,5}$/u.test(String(candidate.servicePrice || ""));
  if (!validPrices && !textOnly) return null;

  // Keep the related/unpriced primary-treatment safety policy at this one
  // authorization boundary; do not ask three downstream components to guess
  // whether the independently approved service can be priced.
  const currentHistory = pricingConflictHistory({
    candidate, conversationHistory, services, serviceAliases,
  });
  const relatedConflict = relatedPricingConflict({
    customerText, treatment: candidate.treatment, conversationHistory: currentHistory,
    services, serviceAliases, resultMedia,
  });
  const unpricedPrimary = unpricedRelatedPrimary({
    customerText, conversationHistory: currentHistory,
    services, serviceAliases, resultMedia,
  });
  // The source explains why a decision was considered, but it never grants
  // permission to ignore a conflicting/unpriced primary treatment. Earlier
  // customer selection cannot silently price another treatment after a topic
  // switch (e.g. unpriced full-body 整骨 vs. related pelvic result images).
  if (relatedConflict || unpricedPrimary) return null;

  return Object.freeze({
    ...candidate,
    prices: Object.freeze([...prices]),
  });
}

module.exports = { resolveApprovedPricingDecision, pricingConflictHistory };
