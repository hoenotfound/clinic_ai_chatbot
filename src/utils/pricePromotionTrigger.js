const { getPricePromotion } = require("./activePromotion");

/**
 * Resolves whether the current AI reply is allowed to trigger promotional media.
 * This keeps the sales side effect fail-closed and independently testable from
 * the channel-specific delivery code in server.js.
 */
async function resolvePricePromotionForReply({
  priceQuery,
  treatment,
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

  const promo = getPricePromotion(promotions, treatment);
  if (!promo) return null;

  if (typeof wasPromoRecentlySent !== "function" || !contactId) {
    return null;
  }

  const recentlySent = await wasPromoRecentlySent(
    contactId,
    promo.imageUrl,
    duplicateWindowHours
  );
  return recentlySent ? null : promo;
}

module.exports = {
  resolvePricePromotionForReply,
};
