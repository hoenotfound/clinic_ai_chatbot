const { hasExplicitPriceRequest, hasCustomerPriceEnquiry, isContextualBarePriceQuestion } = require("./customerEnquiryEvidence");
const clinicConfig = require("../config/clinicConfig");
const { relatedPricingConflict } = require("./relatedServicePolicy");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
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
  treatment,
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
  if (
    (priceQuery !== true && packageQuery !== true) ||
    !(hasCustomerPriceEnquiry(customerText) ||
      (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
        isContextualBarePriceQuestion(customerText, treatment))) ||
    (clinicConfig.automatedFollowUp?.assessmentFirstPricingEnabled === true &&
      !hasExplicitPriceRequest(customerText, { treatment })) ||
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

  // Promotional media always belongs to its priced service, never to a
  // related service that merely borrows result examples. Protect against
  // incorrect AI treatment selection and short price follow-ups alike.
  if (relatedPricingConflict({
    customerText, treatment, conversationHistory,
    services, serviceAliases, resultMedia,
  })) return null;

  const genericBundle = getPricePromotionBundle(
    promotions,
    treatment,
    null
  );
  if (!genericBundle) return null;

  const mentionedPackages = findMentionedPromotionPackages(
    genericBundle.packages,
    customerText
  );
  if (mentionedPackages.length > 1) return null;

  const recentContext = mentionedPackages.length === 0
    ? recentCustomerPackageContext(
        genericBundle.packages,
        conversationHistory,
        customerText
      )
    : { packages: [], ambiguous: false };
  if (recentContext.ambiguous) return null;

  // Customer wording is authoritative. Never let a model-only package guess
  // narrow a generic service enquiry to one arbitrary package.
  const contextualPackage =
    mentionedPackages[0] || recentContext.packages[0] || null;
  const selectedOption = contextualPackage?.name || null;
  const bundle = selectedOption
    ? getPricePromotionBundle(promotions, treatment, selectedOption)
    : genericBundle;
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
