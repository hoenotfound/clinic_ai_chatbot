const { hasExplicitPriceRequest, hasCustomerPriceEnquiry, isContextualBarePriceQuestion } = require("./customerEnquiryEvidence");
const clinicConfig = require("../config/clinicConfig");
const { relatedPricingConflict, unpricedRelatedPrimary } = require("./relatedServicePolicy");
const { verifiedPricesForService, requestedPricePackages } = require("./verifiedPriceReply");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { resolveClarifiedPriceService } = require("./priceClarificationContext");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const {
  findMentionedPromotionPackages,
  getPricePromotionBundle,
} = require("./activePromotion");
const { mediaVariants, resolveLocalizedMedia } = require("./mediaLocalization");

/**
 * Resolves whether the current AI reply is allowed to trigger promotional media.
 * This keeps the sales side effect fail-closed and independently testable from
 * the channel-specific delivery code in server.js.
 */
function recentCustomerPackageContext(packages, conversationHistory, currentText) {
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const current = String(currentText || "").trim();

  let skippedCurrentTurn = false;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.role !== "user" || typeof entry?.content !== "string") continue;
    const content = entry.content.trim();
    if (!content) continue;

    // The history snapshot normally ends with the current inbound customer
    // turn. Skip that copy because currentText was already checked directly.
    if (!skippedCurrentTurn && current && content === current) {
      skippedCurrentTurn = true;
      continue;
    }

    // Only the immediately previous meaningful customer turn may carry package
    // context into a short follow-up such as "多少钱？". Do not scan older
    // history, otherwise a stale Package B mention can narrow a later generic
    // service-price enquiry many turns after the conversation moved on.
    const matches = findMentionedPromotionPackages(packages, content);
    return {
      packages: matches.length === 1 ? matches : [],
      ambiguous: matches.length > 1,
    };
  }
  return { packages: [], ambiguous: false };
}

async function resolvePricePromotionForReply({
  priceQuery,
  packageQuery,
  verifiedPricingIntent = false,
  aiPricingEnabled = false,
  treatment,
  verifiedServiceFromText = null,
  customerText,
  conversationHistory,
  flagged,
  bookingReady,
  keywordReason,
  needsAttention,
  textSendSucceeded,
  promotions,
  services = clinicConfig.services,
  serviceAliases = clinicConfig.serviceAliases,
  resultMedia = clinicConfig.resultMedia,
  language = "en",
  contactId,
  wasPromoRecentlySent,
  hasUnconfirmedMediaDelivery,
  duplicateWindowHours = 24,
}) {
  // Questions about the separately verified FREE introductory experience
  // are not a request for paid treatment price graphics.
  if (isComplimentaryAssessmentFeeQuestion(
    customerText,
    clinicConfig.automatedFollowUp?.complimentaryAssessmentExperienceEnabled === true,
    conversationHistory
  )) return null;
  const clarificationService = clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true
    ? resolveClarifiedPriceService({
        customerText, conversationHistory, services, serviceAliases,
      }) : null;
  const verifiedClarification = Boolean(treatment) &&
    clarificationService === treatment && verifiedServiceFromText === treatment;
  const verifiedPriceRequest = (aiPricingEnabled && verifiedPricingIntent) ||
    hasExplicitPriceRequest(customerText, { treatment }) ||
    verifiedClarification;
  if (aiPricingEnabled && !verifiedPricingIntent) return null;
  if (
    // A verified monetary question is sufficient for opted-in clinics even
    // when the LLM under-classifies priceQuery. Keep all media safety checks.
    (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true
      ? (!treatment || !verifiedServiceFromText || verifiedServiceFromText !== treatment ||
          !verifiedPriceRequest)
      : (priceQuery !== true && packageQuery !== true)) ||
    !(aiPricingEnabled && verifiedPricingIntent) &&
      !(hasCustomerPriceEnquiry(customerText) ||
        (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
          (isContextualBarePriceQuestion(customerText, treatment) || verifiedClarification))) ||
    (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
      !verifiedPriceRequest) ||
    hasClinicalMediaRisk(customerText) ||
    !treatment ||
    flagged ||
    bookingReady ||
    keywordReason ||
    needsAttention ||
    textSendSucceeded !== true
  ) {
    return null;
  }

  if (relatedPricingConflict({
    customerText, treatment, conversationHistory, services, serviceAliases, resultMedia,
  }) || (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
    unpricedRelatedPrimary({
      customerText, conversationHistory, services, serviceAliases, resultMedia,
    }))) return null;

  const genericBundle = getPricePromotionBundle(
    promotions,
    treatment,
    null
  );
  if (!genericBundle) return null;

  let bundle;
  if (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true) {
    // The price graphic and the actual text quote must be sourced from the
    // same independently verified active package options. Any conflicting,
    // missing or ambiguous amount suppresses ALL optional price graphics.
    const verified = verifiedPricesForService(
      treatment, promotions, customerText, conversationHistory,
      { clarifiedPriceService: clarificationService }
    );
    if (!verified?.length) return null;
    const requested = requestedPricePackages(
      genericBundle.packages, customerText, conversationHistory,
      { clarifiedPriceService: clarificationService, treatment }
    );
    const approved = new Set(verified.map((option) => option.name));
    if (approved.size !== requested.length ||
        requested.some((option) => !approved.has(option.name))) return null;
    bundle = { ...genericBundle, packages: requested };
  } else {
    // Preserve the original fail-closed policy for clients that do not use
    // assessment-first pricing. Multiple named packages still need review.
    const mentionedPackages = findMentionedPromotionPackages(
      genericBundle.packages, customerText
    );
    if (mentionedPackages.length > 1) return null;
    const recentContext = mentionedPackages.length === 0
      ? recentCustomerPackageContext(
          genericBundle.packages, conversationHistory, customerText
        )
      : { packages: [], ambiguous: false };
    if (recentContext.ambiguous) return null;
    const contextualPackage =
      mentionedPackages[0] || recentContext.packages[0] || null;
    const selectedOption = contextualPackage?.name || null;
    bundle = selectedOption
      ? getPricePromotionBundle(promotions, treatment, selectedOption)
      : genericBundle;
  }
  if (!bundle) return null;

  // Missing verification must never mean permission to retry a possibly
  // accepted image. Keep the AI text reply independent of this optional send.
  if (typeof wasPromoRecentlySent !== "function" ||
      typeof hasUnconfirmedMediaDelivery !== "function" || !contactId) {
    return null;
  }

  const unsentPackages = [];
  for (const packageOption of bundle.packages) {
    let recentlySent = false;
    for (const variant of mediaVariants(packageOption)) {
      // The provider may have accepted an earlier send even when no delivery
      // receipt was persisted. Check every configured language variant, not
      // just the current reply language, before the normal 24-hour cooldown.
      // An unresolved option holds the *whole* package selection so a
      // two-package offer cannot be sent as a misleading partial bundle.
      try {
        if (await hasUnconfirmedMediaDelivery(contactId, variant.imageUrl)) {
          return null;
        }
      } catch (error) {
        // This is optional sales media; an unavailable receipt lookup must
        // not fail the already-accepted AI text reply or permit a duplicate.
        console.warn("Skipping promotional images: delivery verification unavailable", error);
        return null;
      }
      if (
        await wasPromoRecentlySent(
          contactId,
          variant.imageUrl,
          variant.caption,
          duplicateWindowHours
        )
      ) {
        recentlySent = true;
        break;
      }
    }
    if (!recentlySent) {
      unsentPackages.push(resolveLocalizedMedia(packageOption, language));
    }
  }

  return unsentPackages.length > 0
    ? { ...bundle, packages: unsentPackages }
    : null;
}

module.exports = {
  resolvePricePromotionForReply,
};
