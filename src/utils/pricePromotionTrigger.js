const {
  findMentionedPromotionPackages,
  getPricePromotionBundle,
} = require("./activePromotion");

/**
 * Resolves whether the current AI reply is allowed to trigger promotional media.
 * This keeps the sales side effect fail-closed and independently testable from
 * the channel-specific delivery code in server.js.
 */
function recentCustomerPackageContext(packages, conversationHistory, currentText) {
  const history = Array.isArray(conversationHistory) ? conversationHistory : [];
  const current = String(currentText || "").trim();

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.role !== "user" || typeof entry?.content !== "string") continue;
    const content = entry.content.trim();
    if (!content || (current && index === history.length - 1 && content === current)) continue;

    const matches = findMentionedPromotionPackages(packages, content);
    if (matches.length > 1) return [];
    if (matches.length === 1) return matches;
  }

  return [];
}

async function resolvePricePromotionForReply({
  priceQuery,
  treatment,
  promotionOption,
  customerText,
  conversationHistory,
  flagged,
  bookingReady,
  keywordReason,
  needsAttention,
  textSendSucceeded,
  promotions,
  contactId,
  wasPromoRecentlySent,
  duplicateWindowHours = 24,
}) {
  if (
    priceQuery !== true ||
    !treatment ||
    flagged ||
    bookingReady ||
    keywordReason ||
    needsAttention ||
    textSendSucceeded !== true
  ) {
    return null;
  }

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

  const recentPackages = mentionedPackages.length === 0
    ? recentCustomerPackageContext(
        genericBundle.packages,
        conversationHistory,
        customerText
      )
    : [];
  if (recentPackages.length > 1) return null;

  // Customer wording is authoritative. A model-only promotionOption must never
  // turn a generic service price enquiry into one arbitrarily selected package.
  // promotionOption is accepted only when it agrees with a package actually
  // established by the customer's current/recent wording.
  const contextualPackage = mentionedPackages[0] || recentPackages[0] || null;
  const modelPackage = promotionOption
    ? getPricePromotionBundle(promotions, treatment, promotionOption)
    : null;
  if (
    contextualPackage &&
    modelPackage?.packages?.length === 1 &&
    modelPackage.packages[0].name !== contextualPackage.name
  ) {
    // Explicit/recent customer wording wins over a mistaken model label.
  }

  const selectedOption = contextualPackage?.name || null;
  const bundle = selectedOption
    ? getPricePromotionBundle(promotions, treatment, selectedOption)
    : genericBundle;
  if (!bundle) return null;

  if (typeof wasPromoRecentlySent !== "function" || !contactId) {
    return null;
  }

  const unsentPackages = [];
  for (const packageOption of bundle.packages) {
    const recentlySent = await wasPromoRecentlySent(
      contactId,
      packageOption.imageUrl,
      packageOption.caption,
      duplicateWindowHours
    );
    if (!recentlySent) unsentPackages.push(packageOption);
  }

  return unsentPackages.length > 0
    ? { ...bundle, packages: unsentPackages }
    : null;
}

module.exports = {
  resolvePricePromotionForReply,
};
