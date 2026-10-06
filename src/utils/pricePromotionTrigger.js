const {
  findMentionedPromotionPackages,
  getPricePromotionBundle,
} = require("./activePromotion");
const { resolveLocalizedMedia } = require("./mediaLocalization");

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
  language = "en",
  contactId,
  wasPromoRecentlySent,
  duplicateWindowHours = 24,
}) {
  if (
    (priceQuery !== true && packageQuery !== true) ||
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

  if (typeof wasPromoRecentlySent !== "function" || !contactId) {
    return null;
  }

  const unsentPackages = [];
  for (const packageOption of bundle.packages) {
    const localizedPackage = resolveLocalizedMedia(packageOption, language);
    const recentlySent = await wasPromoRecentlySent(
      contactId,
      localizedPackage.imageUrl,
      localizedPackage.caption,
      duplicateWindowHours
    );
    if (!recentlySent) unsentPackages.push(localizedPackage);
  }

  return unsentPackages.length > 0
    ? { ...bundle, packages: unsentPackages }
    : null;
}

module.exports = {
  resolvePricePromotionForReply,
};
