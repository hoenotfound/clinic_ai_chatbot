"use strict";

// Explain two already-quoted pelvic packages from CURRENT configured offers.
// This is a text-only informational continuation, not price-image permission.
// Never use a model/advertisement/CRM guess or the original media captions as
// authority for a new customer's first pricing enquiry.
const { getActivePromotions, promotionPackages } = require("./activePromotion");
const { recentVerifiedPricingSession } = require("./shadowPriceException");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");

const TREATMENT = "骨盆调理";
const COMPARE = /(?:分别|分別|差别|差別|区别|區別|不同|比较|比較|对比|對比|有何不同|difference|different|compar(?:e|ison)|beza|berbeza|banding)/iu;
const PACKAGE = /(?:配套|套餐|package|pakej)/iu;
const FORBIDDEN = /(?:不要|不用|不想|取消|退款|退费|退費|订金|訂金|押金|停止|退订|退訂|改聊|换成|換成|\b(?:stop|unsubscribe|refund|cancel|instead|deposit)\b)/iu;
const AMOUNT = /\b(?:RM|MYR)\s*([1-9]\d{1,5})\b/giu;
const MAX_QUOTE_AGE_MS = 3 * 60 * 60 * 1000;

function safeOffer(item) {
  const price = item?.pricing?.offer;
  return Number.isSafeInteger(price) && price > 0 && price < 100000
    ? price : null;
}
function includedItems(item, locale) {
  const localized = item?.mediaTranslations?.[locale]?.caption;
  const source = String(localized || item?.caption || "");
  const points = source.split(/\r?\n/u).map(s => s.trim())
    .filter(s => /^✅/u.test(s))
    .map(s => s.replace(/^✅\s*/u, "").trim())
    .filter(s => s && s.length <= 110);
  return points.length >= 2 && points.length <= 8 ? points : null;
}

function resolveNeutroPelvicPackageComparison({
  customerText = "", conversationHistory = [], services = [],
  serviceAliases = [], promotions = [], language = "zh", now = Date.now(),
} = {}) {
  const current = String(customerText || "").normalize("NFKC").trim();
  if (!current || current.length > 120 || !COMPARE.test(current) ||
      !PACKAGE.test(current) || FORBIDDEN.test(current) ||
      hasClinicalMediaRisk(current)) return null;

  const mentionedAmounts = [...current.matchAll(AMOUNT)].map(m => Number(m[1]));
  if (mentionedAmounts.length !== 2 ||
      new Set(mentionedAmounts).size !== 2) return null;

  if (!(services || []).some(s => s?.name === TREATMENT)) return null;
  const mentionedTreatments = findServicesInText(
    current, serviceCandidates(services, serviceAliases)
  );
  if (mentionedTreatments.some(name => name !== TREATMENT)) return null;

  const active = getActivePromotions(promotions, new Date(now))
    .filter(p => p?.linkedService === TREATMENT);
  if (active.length !== 1) return null;
  const options = promotionPackages(active[0]);
  if (options.length !== 2) return null;
  const a = options.find(p => p.name === "Package A");
  const b = options.find(p => p.name === "Package B");
  if (!a || !b || !safeOffer(a) || !safeOffer(b) ||
      safeOffer(a) === safeOffer(b) ||
      ![safeOffer(a), safeOffer(b)].every(p => mentionedAmounts.includes(p)))
    return null;

  // The customer must have explicitly chosen pelvic treatment in this
  // verified session, and the AI must ALREADY have quoted both live prices
  // together. We cannot infer a purchase decision from a price pair alone.
  const session = recentVerifiedPricingSession(conversationHistory, customerText, now);
  if (!session || session.length < 4) return null;
  const previous = session.slice(0, -1);
  const recentCustomerSelection = previous.some(t => t.role === "user" &&
    t.pricingCreatedAtMs >= now - MAX_QUOTE_AGE_MS &&
    safeServiceFromCustomer(t.content, services, serviceAliases)?.name === TREATMENT);
  if (!recentCustomerSelection) return null;
  const quoted = previous.some(t => t.role === "assistant" &&
    t.pricingCreatedAtMs >= now - MAX_QUOTE_AGE_MS &&
    String(t.content || "").includes(TREATMENT) &&
    String(t.content || "").includes("Package A") &&
    String(t.content || "").includes("Package B") &&
    String(t.content || "").includes("RM" + safeOffer(a)) &&
    String(t.content || "").includes("RM" + safeOffer(b)));
  if (!quoted) return null;
  const locale = String(language || "zh").toLowerCase().startsWith("ms") ? "ms" :
    String(language || "zh").toLowerCase().startsWith("en") ? "en" : "zh";
  const itemsA = includedItems(a, locale);
  const itemsB = includedItems(b, locale);
  if (!itemsA || !itemsB || !a.title || !b.title) return null;

  const format = (item, points) =>
    item.name + " (RM" + safeOffer(item) + " | " + item.title + "):\n" +
    points.map(point => "• " + point).join("\n");
  const ending = locale === "en"
    ? "Both include pelvic and posture care. The main differences are the session length and included care. The clinic can confirm voucher eligibility, and the practitioner can recommend the suitable option after an assessment."
    : locale === "ms"
      ? "Kedua-duanya termasuk penjagaan pelvis dan postur. Perbezaannya ialah tempoh dan rawatan yang termasuk. Syarat baucar perlu disahkan dengan pusat dan pilihan sesuai boleh dibincangkan selepas penilaian."
      : "两个配套都有骨盆与体态调整，主要区别是护理时长和包含的项目。优惠券使用条件请向门店确认；适合哪一种，可以先让中医师评估后再决定哦 😊";
  const lead = locale === "en" ? "Here's the difference between the two packages:"
    : locale === "ms" ? "Ini perbezaan antara kedua-dua pakej:"
      : "这两个骨盆调理配套的区别是：";
  return Object.freeze({
    treatment: TREATMENT,
    reply: lead + "\n\n" + format(a, itemsA) + "\n\n" +
      format(b, itemsB) + "\n\n" + ending,
    type: "text_only",
  });
}
module.exports = { resolveNeutroPelvicPackageComparison };
