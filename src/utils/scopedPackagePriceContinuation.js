"use strict";

// An ad-initiated conversation can contain a customer-confirmed treatment,
// followed by "price?" -> "which treatment?" -> "all of them". In this
// *bounded* exchange "all of them" refers to that treatment's package options,
// not the clinic-wide service catalog. Never use ad/CRM/model labels alone.
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { hasExplicitPriceRequest, hasCustomerServiceEnquiry } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { getActivePromotions, promotionPackages } = require("./activePromotion");
const { verifiedPricesForService } = require("./verifiedPriceReply");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");

const SCOPE_ANSWER = /^(?:(?:我|我想|想|都|全部|每个|每個)\s*)?(?:每\s*(?:一\s*)?[项項个個种種]\s*(?:都)?\s*(?:想了解|想知道|了解一下|想看|都想了解|的价格|的價錢|的价钱|的價格|的配套|的套餐)?|(?:两|兩|2)\s*(?:个|個|种|種|项|項)?\s*(?:都想了解|都要了解|个都|個都)|(?:both|all\s+(?:of\s+)?them|each\s+(?:one|package)|both\s+packages?)(?:\s+(?:please|prices?|options?))?|(?:kedua-dua|semua\s+pakej)(?:\s+(?:nak\s+tahu|harga))?|都想了解|全部都想了解)[\s?!？。!！]*$/iu;
// The customer's FIRST direct pricing enquiry should not trigger another
// "which treatment?" question when they already chose one treatment here.
// Keep the patterns intentionally narrow: price objections, budget statements,
// free assessment questions and generic details do not qualify.
const DIRECT_AD_SCOPED_PRICE =
  /^(?:(?:请问|請問|我想问|我想問|想问|想問|我想了解|想了解)\s*)?(?:(?:这|這)(?:个|個)(?:疗程|療程)?\s*)?(?:价钱|價錢|价格|價格|收费|收費|费用|費用)(?:这方面|這方面|方面|呢|多少[钱錢]|[?？])?[\s?？。!！]*$|^(?:price|pricing|cost|harga)(?:\s+(?:please|pls|ya))?[\s?？.!！]*$/iu;
const EXPLICIT_ALL_SERVICES = /(?:所有|全部|每个|每個|每一)(?:的)?(?:疗程|療程|服务|服務|项目|項目)|(?:全院|整间|整間|全部)(?:的)?(?:价目表|價目表)|(?:all|every|whole|entire)\s+(?:the\s+)?(?:clinic|treatments?|services?)|\b(?:price\s+list|full\s+menu)\b/iu;
const STOP_OR_SWITCH = /(?:别|別|不要|不用|换个|換個|改聊|退订|退訂|不想了解|不感兴趣|\b(?:stop|unsubscribe|switch|instead|rather|not\s+interested|don't\s+want|do\s+not\s+want|opt\s*out)\b)/iu;
const STAFF_PREFIX = "[Verified STAFF message]";
const PRICE_CLARIFICATION =
  /(?:哪(?:一)?(?:项|項|个|個|种|種)|什么|什麼).{0,90}(?:价[格钱錢]|價錢|费[用]?|費用)|(?:[价價](?:格|钱|錢)|费用|費用).{0,80}(?:哪(?:一)?(?:项|項|个|個)|什么|什麼)|\b(?:which|what)\b.{0,90}\b(?:price|cost|fees?|charges?)\b|\b(?:price|cost|fees?|charges?)\b.{0,90}\b(?:which|what)\b|\b(?:harga|bayaran)\b.{0,65}\b(?:rawatan|pakej)\b.{0,30}\b(?:mana|apa)\b/iu;

function messageText(message) {
  if (typeof message?.content === "string") return message.content.trim();
  if (!Array.isArray(message?.content)) return "";
  const texts = message.content.filter(x => x?.type === "text" && typeof x.text === "string");
  return texts.map(x => x.text).join(" ").trim();
}

function resolveScopedPackagePriceContinuation({
  customerText, conversationHistory = [], metaAdContext = null,
  services = [], serviceAliases = [], promotions = [], now = Date.now(),
} = {}) {
  const current = String(customerText || "").trim();
  const directPrice = DIRECT_AD_SCOPED_PRICE.test(current) &&
    hasExplicitPriceRequest(current);
  const clarifiedPackages = SCOPE_ANSWER.test(current);
  if (!current || current.length > 100 || (!clarifiedPackages && !directPrice) ||
      EXPLICIT_ALL_SERVICES.test(current) || STOP_OR_SWITCH.test(current) ||
      hasClinicalMediaRisk(current) || !metaAdContext ||
      !Number.isFinite(now)) return null;
  const adTime = Date.parse(String(metaAdContext.attributedAt || ""));
  if (!Number.isFinite(adTime) || adTime > now ||
      now - adTime > 7 * 24 * 60 * 60 * 1000) return null;
  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(x => ["user", "assistant"].includes(x?.role));
  if (turns.length < (directPrice ? 3 : 5) ||
      turns.at(-1)?.role !== "user" ||
      messageText(turns.at(-1)) !== current) return null;
  if (clarifiedPackages) {
    const question = turns.at(-2), priorPrice = turns.at(-3);
    if (question.role !== "assistant" || priorPrice.role !== "user" ||
        !PRICE_CLARIFICATION.test(messageText(question)) ||
        messageText(question).startsWith(STAFF_PREFIX) ||
        !hasExplicitPriceRequest(messageText(priorPrice)) ||
        STOP_OR_SWITCH.test(messageText(priorPrice)) ||
        hasClinicalMediaRisk(messageText(priorPrice))) return null;
  }

  // Require the customer to have independently selected exactly one service
  // before asking about pricing. There can be automated replies and images
  // between customer turns, but no staff turn, switch or ambiguous new topic.
  const previous = turns.slice(0, directPrice ? -1 : -3);
  const earlierCustomers = previous.flatMap((turn,i) => turn.role === "user" ? [i] : []);
  if (!earlierCustomers.length || earlierCustomers.length > 3) return null;
  const selectedAt = earlierCustomers.at(-1);
  const selectedText = messageText(previous[selectedAt]);
  if (!selectedText || STOP_OR_SWITCH.test(selectedText) ||
      !hasCustomerServiceEnquiry(selectedText) || hasClinicalMediaRisk(selectedText)) return null;
  const selected = safeServiceFromCustomer(selectedText, services, serviceAliases);
  const candidates = serviceCandidates(services, serviceAliases);
  if (!selected || (findServicesInText(selectedText, candidates).length !== 1) ||
      !/(?:有兴趣|有興趣|想了解|想知道|感兴趣|感興趣|interested|enquir|inquir|berminat|nak\s+tahu|mahu\s+tahu)/iu.test(selectedText)) return null;
  for (const turn of previous.slice(selectedAt + 1)) {
    const text = messageText(turn);
    if (!text || text.startsWith(STAFF_PREFIX) ||
        STOP_OR_SWITCH.test(text) && turn.role === "user") return null;
    // Neither a later customer message nor an assistant-mentioned different
    // treatment may silently broaden/switch the current pricing subject.
    const mentioned = findServicesInText(text, candidates);
    if (mentioned.some(name => name !== selected.name) ||
        (turn.role === "user" && mentioned.length > 1)) return null;
  }

  const active = getActivePromotions(promotions).filter(p =>
    p.linkedService === selected.name && p.sendOnPriceQuery === true
  );
  if (active.length !== 1) return null;
  const packages = promotionPackages(active[0]);
  if (packages.length < 2 || packages.length > 4) return null;
  const prices = verifiedPricesForService(
    selected.name, promotions, current, conversationHistory,
    { allowTextOnlyOffers: true }
  );
  if (!prices || prices.length !== packages.length ||
      prices.some(x => !packages.some(y => y.name === x.name))) return null;

  return Object.freeze({
    type: "price", treatment: selected.name, source: "customer_scoped_packages",
    clarifiedPriceService: selected.name, prices, servicePrice: null,
  });
}

module.exports = { resolveScopedPackagePriceContinuation };
