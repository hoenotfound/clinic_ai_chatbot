"use strict";

const { confirmedSingleBranchLocationAnswer } = require("./verifiedPricingBusinessFacts");
const { campaignContextReply } = require("./neutroBreastRm68Campaign");
const { planNeutroReviewContinuation } = require("./neutroReviewContinuation");
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");

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
  const location = confirmedSingleBranchLocationAnswer({
    customerText: message, branches, language,
  });
  if (location) return location;
  const campaign = campaignContextReply({ history, customerText: message, now });
  if (campaign) return { kind: "verified_rm68_campaign", reply: campaign };
  if (!isStandalonePriceQuestion(message) || !hasExplicitPriceRequest(message)) return null;

  const verified = planNeutroReviewContinuation({
    customerText: message, conversationHistory: history, language,
    services, serviceAliases, promotions,
  });
  if (verified) return verified;
  const locale = String(language || "").toLowerCase();
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
