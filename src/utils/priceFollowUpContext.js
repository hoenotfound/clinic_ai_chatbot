"use strict";

const { hasExplicitPriceRequest, isStandalonePriceQuestion } = require("./customerEnquiryEvidence");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const {
  getActivePromotions, promotionPackages, findMentionedPromotionPackages,
} = require("./activePromotion");
const {
  serviceCandidates, findServicesInText,
} = require("./conversationPromptContext");

// Only explicit monetary questions can carry customer-named service context.
// A generic "packages?" or consent to future promotions is not sufficient.
// Do not treat "how much longer", "how much time", etc. as a price question.
const REFERENTIAL_PRICE_QUESTION =
  /(?:^(?:这个|這個|那个|那個|这个配套|這個配套|这项|這項|它|这个疗程|這個療程|这套|這套).{0,18}(?:多少钱|多少錢|几多钱|幾多錢|几钱|幾錢|价钱|價錢|价格|價格|费用|費用)|\b(?:how\s+much\s+(?:is|does|for|would)\s+(?:it|this|that|the\s+(?:one|package|treatment))|(?:what(?:'s| is)\s+(?:the\s+)?(?:price|cost)\s+(?:for|of)\s+(?:it|this|that))|(?:price|cost)\s+(?:of|for)\s+(?:this|that|it))\b|\b(?:berapa\s+(?:harga|kos)\s+(?:ini|itu|nya)|harga\s+(?:yang\s+)?(?:ini|itu|tersebut)\s+berapa)\b)/iu;
const TOPIC_RESET =
  /(?:换个|換個|改聊|另外想|先不聊|不聊这个|不聊這個|其他话题|其他話題|换话题|換話題|不(?:想|要|用|需要).{0,15}(?:价|價|钱|錢|配套)|别.{0,12}(?:报价|報價)|(?:stop|unsubscribe|opt\s*out)|\b(?:instead|rather|switch|another\s+treatment|different\s+treatment|not\s+interested|do\s+not\s+want|don't\s+want|tak\s+nak|tidak\s+mahu)\b)/iu;
const STAFF_MESSAGE = /^\[Verified STAFF message\]/u;
const BROAD_PRICE_QUESTION =
  /(?:所有|全部|全部疗程|全部療程|每个疗程|每個療程|每项|每項|所有配套|\b(?:all|every|full\s+list|complete\s+list|senarai\s+semua)\b)/iu;
const PACKAGE_BRIDGE =
  /(?:配套|套餐|价|價|费用|費用|多久|包括|包含|区别|區別|有什么|有什麼|这个|這個|那個|那个|\b(?:package|pakej|what|include|included|difference|detail|option|that|this)\b)/iu;

function isContextualPriceReference(customerText) {
  const value = String(customerText || "").trim();
  return value.length <= 115 &&
    hasExplicitPriceRequest(value) && REFERENTIAL_PRICE_QUESTION.test(value) &&
    !TOPIC_RESET.test(value) && !BROAD_PRICE_QUESTION.test(value);
}

function currentPricePackageOptions(treatment, promotions) {
  const active = getActivePromotions(promotions).filter((promotion) =>
    promotion?.sendOnPriceQuery === true && promotion.linkedService === treatment
  );
  return active.length === 1 ? promotionPackages(active[0]) : [];
}

function currentMatchesPromotion(customerText, options, promotions) {
  const named = findMentionedPromotionPackages(options, customerText);
  if (named.length) return true;
  // A current package term that exists for some other promotion must not
  // borrow a previous service. An unqualified deictic question is different.
  const all = getActivePromotions(promotions).filter((p) => p.sendOnPriceQuery === true);
  const otherPackage = all.some((p) =>
    findMentionedPromotionPackages(promotionPackages(p), customerText).length > 0
  );
  return !otherPackage;
}

function resolveVerifiedPriceFollowUpService({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  promotions = [],
} = {}) {
  const current = String(customerText || "").trim();
  if (!current || current.length > 115 ||
      !(hasExplicitPriceRequest(current) || isStandalonePriceQuestion(current)) ||
      TOPIC_RESET.test(current) || BROAD_PRICE_QUESTION.test(current)) return null;

  const candidates = serviceCandidates(services, serviceAliases);
  // A current multi-service or mixed-treatment enquiry is not a short,
  // service-free follow-up. Do not fall back to an older service.
  if (findServicesInText(current, candidates).length) return null;

  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter((item) => item?.role === "user" || item?.role === "assistant");
  if (!turns.length) return null;

  let cursor = turns.length - 1;
  if (turns[cursor]?.role === "user" &&
      typeof turns[cursor].content === "string" &&
      turns[cursor].content.trim() === current) cursor -= 1;

  let priorCustomerTurns = 0;
  const bridging = [];
  while (cursor >= 0 && priorCustomerTurns < 2) {
    const turn = turns[cursor--];
    if (turn.role === "assistant") {
      // A staff reply breaks automatic price-context carryover, even when the
      // staff message asks a question naming a treatment.
      if (typeof turn.content !== "string" || STAFF_MESSAGE.test(turn.content.trim())) return null;
      continue;
    }
    priorCustomerTurns += 1;
    if (typeof turn.content !== "string" || !turn.content.trim()) return null;
    const text = turn.content.trim();
    if (TOPIC_RESET.test(text)) return null;

    const mentioned = findServicesInText(text, candidates);
    const named = safeServiceFromCustomer(text, services, serviceAliases);
    if (mentioned.length && !named) return null;
    if (named) {
      // Two intervening customer turns are permitted only when the newer turn
      // is a clearly related package discussion, not an unrelated subject.
      const options = currentPricePackageOptions(named.name, promotions);
      if (!options.length || !currentMatchesPromotion(current, options, promotions)) return null;
      if (bridging.some((bridge) =>
        !PACKAGE_BRIDGE.test(bridge) ||
        !findMentionedPromotionPackages(options, bridge).length
      )) return null;
      // A bare "price?" requires recent customer service evidence, not an
      // assistant or advertisement that guessed the service.
      return named;
    }

    // Only a directly named package may bridge one customer turn between a
    // service name and a new question. Never use an anonymous "this" to bridge.
    if (!PACKAGE_BRIDGE.test(text)) return null;
    if (bridging.length) return null;
    bridging.push(text);
  }
  return null;
}

module.exports = {
  isContextualPriceReference, resolveVerifiedPriceFollowUpService,
};
