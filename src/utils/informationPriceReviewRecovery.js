"use strict";

// Recover only an INFORMATION review that should instead have been an
// objectively answerable, current treatment-price question. Never downgrade
// clinical/safety reviews or create a treatment from the AI/CRM/ad.
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { resolveVerifiedPriceFollowUpService } = require("./priceFollowUpContext");
const { verifiedPricesForService, ensureVerifiedPriceReply } = require("./verifiedPriceReply");

function planInformationPriceRecovery({
  flagged = false, reviewRequired = false, reviewType = null,
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  promotions = [], resultMedia = [], language = "zh",
  hasKeywordAlert = false, urgentSafety = false, activeSafety = false,
  explicitStaffRequest = false, marketingStop = false,
  pendingClinicalReview = true, enabled = false,
} = {}) {
  const text = String(customerText || "").trim();
  if (enabled !== true || flagged !== true || reviewRequired !== true ||
      reviewType !== "information" || !text || hasKeywordAlert ||
      urgentSafety || activeSafety || explicitStaffRequest || marketingStop ||
      pendingClinicalReview !== false || hasClinicalMediaRisk(text) ||
      !hasExplicitPriceRequest(text)) return null;

  const service = resolveVerifiedPriceFollowUpService({
    customerText: text, conversationHistory, services, serviceAliases, promotions,
    allowContinuedPriceContext: true,
  });
  if (!service) return null;
  const prices = verifiedPricesForService(service.name, promotions, text, conversationHistory);
  if (!prices?.length) return null;
  const quoted = ensureVerifiedPriceReply({
    customerText: text, reply: "好的 😊", treatment: service.name,
    conversationHistory, services, serviceAliases, promotions, resultMedia, language,
    allowContinuedPriceContext: true,
  });
  if (!quoted.restored || !quoted.reply || !prices.every(p => quoted.reply.includes(p.price)))
    return null;
  return Object.freeze({ treatment: service.name, reply: quoted.reply });
}

module.exports = { planInformationPriceRecovery };
