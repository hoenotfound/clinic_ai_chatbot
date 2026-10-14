"use strict";

const { getActivePromotions, promotionPackages } = require("./activePromotion");
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasTreatmentPriceContent } = require("./initialOfferReplyGuard");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { relatedPricingConflict, unpricedRelatedPrimary } = require("./relatedServicePolicy");

const SALE_PRICE_LINE =
  /(?:优惠后|優惠後|现在只需|現在只需|仅需|僅需|只需|现价|現價|特价|特價|促销价|促銷價|first[\s-]*trial|now\s+only|after\s+(?:the\s+)?voucher|harga\s+promosi|selepas\s+baucar)/iu;

function configuredOfferPrice(caption) {
  const normalized = String(caption || "").normalize("NFKC")
    .replace(/[\uFE0F\u20E3]/gu, "");
  const line = normalized.split(/[\n。]/u)
    .filter((part) => SALE_PRICE_LINE.test(part))
    .findLast((part) => /\b(?:RM|MYR)\s*\d{2,5}\b/iu.test(part));
  if (!line) return null;
  const matches = [...line.matchAll(/\b(?:RM|MYR)\s*(\d{2,5})\b/giu)];
  // Prefer only an explicitly marked offer price. Never mistake an RM100
  // voucher or an original-price amount for the price being quoted.
  const amount = matches.at(-1)?.[1];
  return amount ? `RM${amount}` : null;
}

// If Gemini ignores an already verified price question, reply using active
// configured package prices. Do not depend on optional images being sent: the
// WhatsApp RM0 gate may suppress media while still allowing the text answer.
function ensureVerifiedPriceReply({
  customerText, reply, treatment, clarifiedPriceService = null,
  services = [], serviceAliases = [], promotions = [],
  resultMedia = [], conversationHistory = [], language = "zh",
} = {}) {
  const original = String(reply || "").trim();
  if (!original || !treatment || hasTreatmentPriceContent(original) ||
      hasClinicalMediaRisk(customerText) ||
      !(hasExplicitPriceRequest(customerText, { treatment }) ||
        clarifiedPriceService === treatment) ||
      relatedPricingConflict({
        customerText, treatment, conversationHistory, services, serviceAliases,
        resultMedia,
      }) ||
      unpricedRelatedPrimary({
        customerText, conversationHistory, services, serviceAliases, resultMedia,
      })) return { reply: original, restored: false };

  const promotionsForService = getActivePromotions(promotions).filter((promotion) =>
    promotion?.sendOnPriceQuery === true &&
    String(promotion.linkedService || "").trim() === treatment
  );
  // Multiple active offers or missing prices must be handled by staff, not
  // resolved through arbitrary package selection or inferred discounts.
  if (promotionsForService.length !== 1) return { reply: original, restored: false };
  const options = promotionPackages(promotionsForService[0]);
  if (!options.length || options.length > 4) return { reply: original, restored: false };
  const prices = options.map((option) => ({
    name: String(option.name || "").trim(),
    title: String(option.title || "").trim(),
    price: configuredOfferPrice(option.caption),
  }));
  if (prices.some((item) => !item.name || !item.price)) {
    return { reply: original, restored: false };
  }

  const locale = String(language || "").toLowerCase();
  const entries = prices.map((item) =>
    `• ${item.name}${item.title ? `（${item.title}）` : ""}：${item.price}`
  ).join("\n");
  const quote = locale.startsWith("ms")
    ? `Untuk ${treatment}, harga promosi terkini ialah:\n${entries}\n\nSyarat baucar atau gabungan diskaun perlu disahkan oleh pihak pusat ya 😊`
    : locale.startsWith("en")
      ? `The current ${treatment} package prices are:\n${entries}\n\nOur centre can confirm voucher terms and whether discounts can be combined 😊`
      : `${treatment}目前的配套价格是：\n${entries}\n\n优惠券的使用条件以及是否能与其他优惠叠加，可以让门店帮你确认哦 😊`;
  return { reply: quote, restored: true };
}

module.exports = { configuredOfferPrice, ensureVerifiedPriceReply };
