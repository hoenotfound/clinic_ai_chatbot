const { hasExplicitPriceRequest, hasCustomerPriceEnquiry, isContextualBarePriceQuestion } = require("./customerEnquiryEvidence");
const clinicConfig = require("../config/clinicConfig");
const { relatedPricingConflict, unpricedRelatedPrimary } = require("./relatedServicePolicy");
const { resolveContinuedTreatmentPriceService, resolveRecentFirstTreatmentPriceService } = require("./priceFollowUpContext");
const { resolveScopedPackagePriceContinuation } = require("./scopedPackagePriceContinuation");
const { verifiedPricesForService, requestedPricePackages } = require("./verifiedPriceReply");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { resolveClarifiedPriceService } = require("./priceClarificationContext");
const { isComplimentaryAssessmentFeeQuestion } = require("./complimentaryAssessmentExperience");
const {
  findMentionedPromotionPackages,
  getPricePromotionBundle,
} = require("./activePromotion");
const { mediaVariants, resolveLocalizedMedia } = require("./mediaLocalization");
const { promotionHasUnsafeClinicalCopy } = require("./promotionClinicalCopyPolicy");

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
  pricingDecision = null,
  aiPricingEnabled = false,
  metaAdContext = null,
  treatment,
  verifiedServiceFromText = null,
  verifiedNumberedSelection = null,
  verifiedShadowPriceService = null,
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
  onSkip = null,
}) {
  const skip = (reason) => {
    if (typeof onSkip === "function") onSkip(reason);
    return null;
  };
  // Questions about the separately verified FREE introductory experience
  // are not a request for paid treatment price graphics.
  if (isComplimentaryAssessmentFeeQuestion(
    customerText,
    clinicConfig.automatedFollowUp?.complimentaryAssessmentExperienceEnabled === true,
    conversationHistory
  )) return skip("intro_assessment_fee");
  // Enabled mode uses one already-verified pricing result for both text and
  // media. Leave the old keyword-backed path intact for Off/Shadow clients.
  if (aiPricingEnabled && (
    !pricingDecision || pricingDecision.treatment !== treatment ||
    !Array.isArray(pricingDecision.prices) || !pricingDecision.prices.length ||
    !["price", "package_options"].includes(pricingDecision.type)
  )) return skip("no_approved_pricing_decision");
  // A confirmed old quote should not generate a second marketing graphic.
  if (aiPricingEnabled && pricingDecision?.source === "confirmed_prior_quote") {
    return skip("price_confirmation_no_new_graphic");
  }
  const clarificationService = aiPricingEnabled
    ? pricingDecision.clarifiedPriceService
    : clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true
      ? resolveClarifiedPriceService({
          customerText, conversationHistory, services, serviceAliases,
        }) : null;
  // Independently verify the same customer-selected service and CURRENT
  // multi-package clarification for optional images. No ad/CRM hint alone
  // can authorize media, and the normal duplicate/RM0 gates stay in force.
  const scopedPackagePrice = resolveScopedPackagePriceContinuation({
    customerText, conversationHistory, metaAdContext,
    services, serviceAliases, promotions,
  });
  const verifiedClarification = Boolean(treatment) &&
    verifiedServiceFromText === treatment &&
    (clarificationService === treatment ||
      scopedPackagePrice?.treatment === treatment ||
      verifiedNumberedSelection === treatment ||
      verifiedShadowPriceService === treatment);
  const verifiedPriceRequest = hasExplicitPriceRequest(customerText, { treatment }) ||
    verifiedClarification;
  const legacyBlocked = !aiPricingEnabled && (
    (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true
      ? (!treatment || !verifiedServiceFromText ||
          verifiedServiceFromText !== treatment || !verifiedPriceRequest)
      : (priceQuery !== true && packageQuery !== true)) ||
    !(hasCustomerPriceEnquiry(customerText) ||
      (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
        (isContextualBarePriceQuestion(customerText, treatment) || verifiedClarification))) ||
    (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
      !verifiedPriceRequest)
  );
  if (
    legacyBlocked ||
    hasClinicalMediaRisk(customerText) ||
    !treatment || flagged || bookingReady || keywordReason ||
    needsAttention || textSendSucceeded !== true
  ) return skip(
    flagged || keywordReason ? "safety_or_review" :
    bookingReady ? "booking_ready" :
    needsAttention ? "staff_review_or_takeover" :
    textSendSucceeded !== true ? "text_not_accepted" :
    legacyBlocked ? "price_intent_unverified" : "treatment_or_clinical_media_block"
  );

  const verifiedContinuedService =
    (aiPricingEnabled === true && pricingDecision?.treatment === treatment) ||
    verifiedNumberedSelection === treatment ||
    verifiedShadowPriceService === treatment ||
    resolveRecentFirstTreatmentPriceService({
      customerText, conversationHistory, services, serviceAliases, promotions,
    })?.name === treatment ||
    (aiPricingEnabled === true &&
      resolveContinuedTreatmentPriceService({
        customerText, conversationHistory, services, serviceAliases, promotions,
      })?.name === treatment);
  if (!verifiedContinuedService && (relatedPricingConflict({
    customerText, treatment, conversationHistory, services, serviceAliases, resultMedia,
  }) || (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
    unpricedRelatedPrimary({
      customerText, conversationHistory, services, serviceAliases, resultMedia,
    })))) return skip("related_treatment_conflict");

  const genericBundle = getPricePromotionBundle(
    promotions,
    treatment,
    null
  );
  if (!genericBundle) return skip("no_active_promotion_graphic");

  let bundle;
  if (aiPricingEnabled) {
    // The decision was verified before the text reply. Do not parse prices or
    // choose package options a second time for the image path.
    const approved = new Set(pricingDecision.prices.map(option => option.name));
    const selected = genericBundle.packages.filter(option => approved.has(option.name));
    if (selected.length !== approved.size) return skip("approved_package_media_mismatch");
    // An explicit comparison of multiple named packages should receive text
    // only, not a large automatic image blast.
    if (findMentionedPromotionPackages(genericBundle.packages, customerText).length > 1) return skip("multi_package_comparison_text_only");
    bundle = { ...genericBundle, packages: selected };
  } else if (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true) {
    const verified = verifiedPricesForService(
      treatment, promotions, customerText, conversationHistory,
      { clarifiedPriceService: clarificationService }
    );
    if (!verified?.length) return skip("active_price_unverified");
    const requested = requestedPricePackages(
      genericBundle.packages, customerText, conversationHistory,
      { clarifiedPriceService: clarificationService, treatment }
    );
    const approved = new Set(verified.map(option => option.name));
    if (approved.size !== requested.length ||
        requested.some(option => !approved.has(option.name))) return skip("package_price_mismatch");
    bundle = { ...genericBundle, packages: requested };
  } else {
    // Preserve the original fail-closed policy for clients that do not use
    // assessment-first pricing. Multiple named packages still need review.
    const mentionedPackages = findMentionedPromotionPackages(
      genericBundle.packages, customerText
    );
    if (mentionedPackages.length > 1) return skip("ambiguous_packages");
    const recentContext = mentionedPackages.length === 0
      ? recentCustomerPackageContext(
          genericBundle.packages, conversationHistory, customerText
        )
      : { packages: [], ambiguous: false };
    if (recentContext.ambiguous) return skip("ambiguous_previous_package");
    const contextualPackage =
      mentionedPackages[0] || recentContext.packages[0] || null;
    const selectedOption = contextualPackage?.name || null;
    bundle = selectedOption
      ? getPricePromotionBundle(promotions, treatment, selectedOption)
      : genericBundle;
  }
  if (!bundle) return skip("no_matching_promotion_package");

  // A configured graphic caption can still contain legacy, unverified
  // clinical promises. Never send those automatically just because the
  // monetary amount itself is verified. The text-only price can still be
  // returned by the independently approved reply path.
  if (promotionHasUnsafeClinicalCopy(bundle.promotion))
    return skip("unverified_clinical_promo_copy");

  // Missing verification must never mean permission to retry a possibly
  // accepted image. Keep the AI text reply independent of this optional send.
  if (typeof wasPromoRecentlySent !== "function" ||
      typeof hasUnconfirmedMediaDelivery !== "function" || !contactId) {
    return skip("delivery_verification_unavailable");
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
          return skip("unconfirmed_media_delivery");
        }
      } catch (error) {
        // This is optional sales media; an unavailable receipt lookup must
        // not fail the already-accepted AI text reply or permit a duplicate.
        console.warn("Skipping promotional images: delivery verification unavailable", error);
        return skip("delivery_verification_failed");
      }
      try {
        if (await wasPromoRecentlySent(
          contactId, variant.imageUrl, variant.caption, duplicateWindowHours
        )) {
          recentlySent = true;
          break;
        }
      } catch (error) {
        console.warn("Skipping promotional images: duplicate lookup unavailable", error);
        return skip("duplicate_lookup_failed");
      }
    }
    if (!recentlySent) {
      unsentPackages.push(resolveLocalizedMedia(packageOption, language));
    }
  }

  return unsentPackages.length > 0
    ? { ...bundle, packages: unsentPackages }
    : skip("all_graphics_already_sent");
}

// Verified pricing paths identify an already sent picture by its media URL,
// even if staff changed the caption. This is particularly important when
// Neutro edits promotion copy after staff has already sent the graphic.
// Other legacy uses retain their historical image+caption match.
function selectPromoDuplicateCheck({
  aiPricingEnabled = false,
  numberedPricingSelection = null,
  shadowPriceException = null,
  scopedPackagePrice = null,
  messagesRepo,
} = {}) {
  if (!messagesRepo ||
      typeof messagesRepo.wasPromoRecentlySent !== "function" ||
      typeof messagesRepo.wasMediaRecentlySent !== "function") {
    throw new Error("Promotion duplicate check requires both message lookups");
  }
  const verifiedPath = aiPricingEnabled === true ||
    Boolean(numberedPricingSelection || shadowPriceException || scopedPackagePrice);
  return verifiedPath
    ? (contactId, imageUrl, _caption, hours) =>
        messagesRepo.wasMediaRecentlySent(contactId, imageUrl, hours)
    : messagesRepo.wasPromoRecentlySent;
}

module.exports = {
  resolvePricePromotionForReply,
  selectPromoDuplicateCheck,
};
