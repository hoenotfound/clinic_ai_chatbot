"use strict";

const { confirmedSingleBranchLocationAnswer, isBusinessLocationQuestion,
  appendRequestedBusinessFacts } = require("./verifiedPricingBusinessFacts");
const { detectMessageLanguage, detectExplicitLanguagePreference } = require("./chatLanguage");
const { campaignContextReply, isCampaignAvailabilityQuestion, hasCampaignConversation, stillDiscussingCampaign } =
  require("./neutroBreastRm68Campaign");
const { planNeutroReviewContinuation } = require("./neutroReviewContinuation");
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { verifiedPricesForService } = require("./verifiedPriceReply");

// A review from the model must never turn an unscoped price question into
// silence. Return a clarification when there is no verified treatment/offer.
// The calling server must verify clinic identity, AI ownership, safety and
// the absence of pending clinical reviews before using any response here.
const SHORT_PRICE = /^(?:(?:请问|請問|想问|想問|那么|那|请问一下)\s*)?(?:价钱|價錢|价格|價格|多少钱|多少錢|收费|收費|费用|費用|how much|price|how much is it|berapa harga)(?:呢|呀|啊|是|吗|嗎)?[\s?!？。!！]*$/iu;
function isStandalonePriceQuestion(text) {
  return SHORT_PRICE.test(String(text || "").trim());
}

function administrativeReviewReply({
  customerText, history, branches, language, services, serviceAliases, promotions, now,
} = {}) {
  const message = String(customerText || "").trim();
  if (!message || message.length > 150) return null;
  // A customer can switch languages between messages. Respect the latest
  // explicit administrative question rather than a stale ad language.
  const ordinaryReplyLanguage = /[\u3400-\u9FFF]/u.test(message) ? "zh"
    : /\b(?:alamat|boleh\s+tahu|berapa\s+harga|dimana|di\s+mana|kat\s+mana|harga)\b/iu.test(message) ? "ms"
      : /\b(?:where|address|how\s+much|price|cost|clinic\s+location)\b/iu.test(message)
        ? "en" : language;
  const campaignActive = hasCampaignConversation(history) && stillDiscussingCampaign(history);
  const replyLanguage = detectExplicitLanguagePreference(message) || (campaignActive ? (detectMessageLanguage(message) || language || ordinaryReplyLanguage) : ordinaryReplyLanguage);
  const mixedLocationPrice = isBusinessLocationQuestion(message) &&
    hasExplicitPriceRequest(message);
  const withRequestedLocation = (answer) => mixedLocationPrice
    ? appendRequestedBusinessFacts({
        customerText: message, reply: answer, branches,
        language: replyLanguage,
      }) : answer;
  const location = confirmedSingleBranchLocationAnswer({
    customerText: message, branches, language: replyLanguage, resolvedLanguage: replyLanguage,
  });
  if (location) return location;
  // Only factual price/availability requests are eligible for the campaign
  // recovery. A broader treatment or medical question stays in normal review.
  const campaign = (isStandalonePriceQuestion(message) ||
    isCampaignAvailabilityQuestion(message) || mixedLocationPrice)
    ? campaignContextReply({ history, customerText: message, now, language: replyLanguage })
    : null;
  if (campaign) return { kind: "verified_rm68_campaign",
    reply: withRequestedLocation(campaign) };
  if (!hasExplicitPriceRequest(message)) return null;
  if (!isStandalonePriceQuestion(message)) {
    // An explicitly named treatment may be quoted only from its configured,
    // independently validated promotional pricing. A different/ambiguous
    // treatment or conflicting captions must never be guessed from an ad.
    const selected = safeServiceFromCustomer(
      message, Array.isArray(services) ? services : [], serviceAliases
    );
    if (!selected?.name) {
      if (!mixedLocationPrice) return null;
      const locale = String(replyLanguage || "").toLowerCase();
      return {
        kind: "mixed_price_location_clarification",
        reply: withRequestedLocation(locale.startsWith("ms")
          ? "Boleh 😊 Awak nak tahu harga rawatan yang mana?"
          : locale.startsWith("en")
            ? "Of course 😊 Which treatment would you like the price for?"
            : "可以的～😊 请问你想了解哪一项护理的收费呢？"),
      };
    }
    const prices = verifiedPricesForService(
      selected.name, promotions, message, history, { allowTextOnlyOffers: true }
    );
    const locale = String(replyLanguage || "").toLowerCase();
    if (!Array.isArray(prices) || prices.length === 0 ||
        prices.some(p => !/^RM[1-9]\d{1,4}$/u.test(String(p.price || "")))) {
      return {
        kind: "explicit_price_needs_confirmation",
        reply: withRequestedLocation(locale.startsWith("ms")
          ? "Saya boleh bantu semak harga terkini untuk " + selected.name + " dengan pusat dahulu 😊"
          : locale.startsWith("en")
            ? "I can help confirm the latest price for " + selected.name + " with the clinic 😊"
            : "我可以先帮你向门店确认 " + selected.name + " 的最新收费哦 😊"),
      };
    }
    const amount = prices.map(p => (p.name === "Main offer" ? selected.name : p.name) +
      "：" + p.price).join("；");
    const voucher = prices.some(p => p.afterVoucher)
      ? (locale.startsWith("en") ? " Listed voucher prices are after the voucher is applied."
        : locale.startsWith("ms") ? " Harga baucar adalah selepas baucar digunakan."
          : " 如有优惠券，以上注明的优惠价为使用优惠券后的价格。")
      : "";
    return {
      kind: "explicit_verified_price",
      reply: withRequestedLocation(locale.startsWith("en")
        ? "Of course 😊 Current verified price: " + amount + "." + voucher
        : locale.startsWith("ms")
          ? "Boleh 😊 Harga promosi semasa: " + amount + "." + voucher
          : "可以的～😊 目前核实的优惠价：" + amount + "。" + voucher),
    };
  }

  const verified = planNeutroReviewContinuation({
    customerText: message, conversationHistory: history, language: replyLanguage,
    services, serviceAliases, promotions,
  });
  if (verified) return verified;
  const locale = String(replyLanguage || "").toLowerCase();
  return {
    kind: "unscoped_price_clarification",
    reply: locale.startsWith("ms")
      ? "Boleh 😊 Awak nak tahu harga rawatan yang mana?"
      : locale.startsWith("en")
        ? "Of course 😊 Which treatment would you like the price for?"
        : "可以的～😊 请问你想了解哪一项护理的收费呢？",
  };
}

module.exports = { administrativeReviewReply, isStandalonePriceQuestion };
