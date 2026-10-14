"use strict";

const { getActivePromotions, promotionPackages, findAmbiguousPromotionPackageTerm, findMentionedPromotionPackages } = require("./activePromotion");
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasTreatmentPriceContent, hasCommercialReplyContent } = require("./initialOfferReplyGuard");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { relatedPricingConflict, unpricedRelatedPrimary } = require("./relatedServicePolicy");

// A voucher, discount, original price or bare amount is never a sale price.
// "After voucher" has priority over a separate pre-voucher promo price.
const FINAL_SALE = /(?:优惠后(?:仅需|只需)?|優惠後(?:僅需|只需)?|after\s+(?:the\s+)?voucher(?:,?\s*only)?|selepas\s+baucar(?:,?\s*hanya)?)\s*[:：]?\s*(?:RM|MYR)\s*([1-9]\d{1,4})(?!\d)/giu;
const DIRECT_SALE = /(?:现在只需|現在只需|现在仅需|現在僅需|只需要|只需|仅需|僅需|优惠价|優惠價|现价|現價|特价|特價|促销价|促銷價|组合体验价(?:只需)?|組合體驗價(?:只需)?|组合限时优惠|組合限時優惠|limited[\s-]*time\s+combo\s+offer|promosi\s+kombo[^\n:：]{0,60}|first[\s-]*trial(?:\s+price)?|trial\s+price|(?:current\s+)?(?:promo|promotional|special|offer|sale)\s+price|now\s+only|harga\s+promosi|harga\s+tawaran|sekarang\s+hanya)\s*[:：]?\s*(?:RM|MYR)\s*([1-9]\d{1,4})(?!\d)/giu;
const MONEY = /\b(?:RM|MYR)\s*\d{2,5}\b/giu;
const BARE_SALE = /^[ \t]*(?:💎[ \t]*)?(?:RM|MYR)[ \t]*([1-9]\d{1,4})[ \t]*(?:[.!。！])?$/gmi;
const ORIGINAL = /(?:原价(?:优惠)?|原價(?:優惠)?|original\s+price|harga\s+asal|normal\s+price)\s*[:：]?\s*(?:RM|MYR)\s*(?:\d{1,3},)?\d{2,5}\b/giu;
const VOUCHER_AFTER = /(?:RM|MYR)\s*\d{2,5}\b\s*(?:voucher|coupon|off|discount|baucar|优惠券|優惠券|折扣券|抵用券|折扣)/giu;
const VOUCHER_BEFORE = /(?:voucher|coupon|baucar|优惠券|優惠券|折扣券|抵用券|折扣)\s*(?:worth\s*)?(?:RM|MYR)\s*\d{2,5}\b/giu;

function priceEvidence(copy) {
  const normalized = String(copy || "").normalize("NFKC").replace(/[\uFE0F\u20E3]/gu, "");
  const finalMatches = [...normalized.matchAll(FINAL_SALE)];
  const directMatches = [...normalized.matchAll(DIRECT_SALE)];
  const bareMatches = /(?:限时优惠|限時優惠|limited[\s-]*time\s+offer|promosi\s+masa\s+terhad)/iu.test(normalized)
    ? [...normalized.matchAll(BARE_SALE)] : [];
  const preferred = finalMatches.length ? finalMatches : (directMatches.length ? directMatches : bareMatches);
  const distinct = [...new Set(preferred.map((m) => m[1]))];
  if (distinct.length !== 1) {
    const unlabeled = normalized.replace(ORIGINAL, " ").replace(VOUCHER_AFTER, " ").replace(VOUCHER_BEFORE, " ");
    return { price: null, ambiguous: preferred.length > 0 || Boolean(unlabeled.match(MONEY)) };
  }
  let remaining = normalized;
  const claims = [...finalMatches, ...directMatches, ...bareMatches].sort((a, b) => b.index - a.index);
  // Overlapping phrases may produce nested matches. Blank them from right
  // to left without shifting source offsets.
  const covered = new Set();
  for (const match of claims) {
    const start = match.index, finish = start + match[0].length;
    for (let i = start; i < finish; i++) covered.add(i);
  }
  remaining = normalized.split("").map((char, i) => covered.has(i) ? " " : char).join("");
  remaining = remaining.replace(ORIGINAL, " ").replace(VOUCHER_AFTER, " ").replace(VOUCHER_BEFORE, " ");
  if (remaining.match(MONEY)) return { price: null, ambiguous: true };
  return { price: "RM" + distinct[0], ambiguous: false };
}

function configuredOfferPrice(copy) {
  return priceEvidence(copy).price;
}

function verifiedPricesForService(treatment, promotions, customerText = "") {
  const matching = getActivePromotions(promotions).filter((promotion) =>
    promotion?.sendOnPriceQuery === true &&
    String(promotion.linkedService || "").trim() === treatment
  );
  if (matching.length !== 1 || findAmbiguousPromotionPackageTerm(matching[0])) return null;
  const options = promotionPackages(matching[0]);
  if (!options.length || options.length > 4) return null;
  const requested = findMentionedPromotionPackages(options, customerText);
  if (requested.length > 1) return null;
  const selected = requested.length === 1 ? requested : options;
  const result = [];
  for (const option of selected) {
    if (!String(option.name || "").trim()) return null;
    const translations = Object.values(option.mediaTranslations || {})
      .map((item) => typeof item === "string" ? item : item?.caption);
    const followUpTranslations = Object.values(option.followUpTranslations || {})
      .map((item) => typeof item === "string" ? item : item?.message);
    const sources = [option.caption, option.followUpMessage, ...translations, ...followUpTranslations]
      .filter((source) => String(source || "").trim());
    const evidence = sources.map(priceEvidence);
    if (evidence.some((entry) => entry.ambiguous)) return null;
    const unique = [...new Set(evidence.map((entry) => entry.price).filter(Boolean))];
    if (unique.length !== 1) return null;
    result.push({ name: String(option.name).trim(), title: String(option.title || "").trim(), price: unique[0] });
  }
  return result;
}

function nonPriceExplanation(reply) {
  const clauses = String(reply || "").split(/\n+|(?<=[。！？!?])\s*/u);
  const kept = clauses.map((line) => line.trim()).filter((line) =>
    line && !hasCommercialReplyContent(line) && !hasTreatmentPriceContent(line) &&
    !/(?:[价價][钱錢格位]|收费|收費|费用|費用|原价|原價|优惠|優惠|折扣|voucher|discount|\b(?:price|pricing|cost|harga|promosi)\b)/iu.test(line)
  );
  return kept.slice(0, 3).join("\n").slice(0, 340).trim();
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
  if (!original || !treatment ||
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

  const prices = verifiedPricesForService(treatment, promotions, customerText);
  const locale = String(language || "").toLowerCase();
  if (!prices) {
    const safeInfo = nonPriceExplanation(original);
    const confirm = locale.startsWith("ms")
      ? "Harga rawatan ini perlu disahkan oleh pihak pusat ya."
      : locale.startsWith("en")
        ? "Our centre needs to confirm the current treatment price."
        : "这项疗程的最新价格需要由门店帮你确认哦。";
    return { reply: safeInfo ? safeInfo + "\n\n" + confirm : confirm, restored: true };
  }
  const entries = prices.map((item) =>
    `• ${item.name === "Main offer" ? treatment : item.name}${item.title && item.name !== "Main offer" ? `（${item.title}）` : ""}：${item.price}`
  ).join("\n");
  const quote = locale.startsWith("ms")
    ? `Untuk ${treatment}, harga promosi terkini ialah:\n${entries}\n\nSyarat baucar atau gabungan diskaun perlu disahkan oleh pihak pusat ya 😊`
    : locale.startsWith("en")
      ? `The current ${treatment} package prices are:\n${entries}\n\nOur centre can confirm voucher terms and whether discounts can be combined 😊`
      : `${treatment}目前的配套价格是：\n${entries}\n\n优惠券的使用条件以及是否能与其他优惠叠加，可以让门店帮你确认哦 😊`;
  const explanation = nonPriceExplanation(original);
  return { reply: explanation ? explanation + "\n\n" + quote : quote, restored: true };
}

module.exports = { configuredOfferPrice, verifiedPricesForService, nonPriceExplanation, ensureVerifiedPriceReply };
