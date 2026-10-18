"use strict";

// The single customer/pricing authorization shared by the text guard,
// verified quote formatter and optional promotional-media selector.
// Shadow's observational AI decision is intentionally NOT authorization:
// only its separately verified exception (or a previously verified numbered
// menu/scoped package continuation) can change the real customer reply.
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { relatedPricingConflict, unpricedRelatedPrimary } = require("./relatedServicePolicy");

const CUSTOMER_GROUNDED_SOURCES = new Set([
  "current_customer", "recent_customer", "continued_customer",
  "recent_first_customer", "customer_price_clarification",
  "customer_scoped_packages", "numbered_price_menu",
]);

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
  const conflict = relatedPricingConflict({
    customerText, treatment: candidate.treatment, conversationHistory,
    services, serviceAliases, resultMedia,
  }) || unpricedRelatedPrimary({
    customerText, conversationHistory, services, serviceAliases, resultMedia,
  });
  if (conflict && !CUSTOMER_GROUNDED_SOURCES.has(candidate.source)) return null;

  return Object.freeze({
    ...candidate,
    prices: Object.freeze([...prices]),
  });
}

module.exports = { resolveApprovedPricingDecision };
