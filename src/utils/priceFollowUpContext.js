"use strict";

const { hasExplicitPriceRequest, isStandalonePriceQuestion, isFirstTrialAmountQuestion } = require("./customerEnquiryEvidence");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
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
  /(?:^(?:这个|這個|那个|那個|这项|這項|那项|那項|它|这套|這套|那套|那套|(?:这个|這個|那个|那個)(?:配套|套餐|疗程|療程|项目|項目|护理|護理|服务|服務))\s*(?:的)?\s*(?:多少钱|多少錢|几多钱|幾多錢|几钱|幾錢|价钱|價錢|价格|價格|费用|費用)|\b(?:how\s+much\s+(?:is|does|for|would)\s+(?:it|this|that|the\s+(?:one|package|treatment))|(?:what(?:'s| is)\s+(?:the\s+)?(?:price|cost)\s+(?:for|of)\s+(?:it|this|that))|(?:price|cost)\s+(?:of|for)\s+(?:this|that|it))\b|\b(?:berapa\s+(?:harga|kos)\s+(?:ini|itu|nya)|harga\s+(?:yang\s+)?(?:ini|itu|tersebut)\s+berapa)\b)/iu;
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


// Strict extension for a short session-price question after several natural
// assessment replies. Never use the bot's guessed treatment as sole evidence.
const SESSION_AMOUNT = /^(?:(?:请问|請問)\s*)?(?:做\s*)?(?:一|1)\s*(?:次|回|趟)\s*(?:疗程|療程|护理|護理)?\s*(?:(?:要|是|花|需|收费|收費)\s*)?(?:多少钱|多少錢|几多钱|幾多錢|几钱|幾錢)[\s?？。!！]*$|^(?:(?:请问|請問)\s*)?(?:做\s*)?(?:一|1)\s*次\s*(?:收费|收費|价格|價格|价钱|價錢|费用|費用)\s*(?:是|要|大概)?\s*多少(?:钱|錢)?[\s?？。!！呢]*$/iu;
const TOPIC_CHANGE = /(?:换个|換個|改聊|不聊|另外想|不要|不想(?:了解|做)|\b(?:instead|switch|another\s+treatment|different\s+treatment|stop|unsubscribe|opt\s*out)\b|退订|退訂)/iu;
const STAFF = /^\[Verified STAFF message\]/u;
const CONTINUED_CONTEXT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pricingMessageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  // Inbound photos are not proof of a treatment. Assistant image captions
  // remain text, and any authenticated staff caption must break continuity.
  const parts = content.filter(p => p?.type === "text" && typeof p.text === "string");
  return parts.map(p => p.text).join("\n");
}

function isVerifiedStaffTurn(turn) {
  return turn?.role === "assistant" && (
    turn.pricingStaffAuthored === true ||
    STAFF.test(pricingMessageText(turn).trim())
  );
}

function isRecentPricingThread(turns, startIndex, now = Date.now()) {
  if (!Number.isFinite(now) || startIndex < 0 || startIndex >= turns.length)
    return false;
  let previous = -Infinity;
  for (const turn of turns.slice(startIndex)) {
    // Only trusted DB timestamps can authorize this *extended* carryover.
    // Synthetic/legacy histories without metadata fail closed.
    const time = turn?.pricingCreatedAtMs;
    if (!Number.isFinite(time) || time < now - CONTINUED_CONTEXT_MAX_AGE_MS ||
        time > now + 60_000 || time < previous) return false;
    previous = time;
  }
  return true;
}
const CONCERN_ANSWER = /^(?:产后|產後)\s*(?:体态|體態|身材|小腹|恢复状态|恢復狀態)[\s。!！]*$/iu;
const AGE_ANSWER = /^(?:大概|约|約|差不多|已经|已經)?\s*(?:\d{1,2}|一|二|两|兩|三|四|五|六|七|八|九|十|半)\s*(?:年|个月|個月|个?月|周|週|星期|天|日)[\s。!！]*$/iu;
const FREE_ASSESSMENT = /^(?:(?:请问|請問)\s*)?(?:(?:免费|免費)\s*)?(?:体态评估|體態評估|评估|評估|1\s*[对對]\s*1\s*评估)\s*(?:\+\s*体验|体验|體驗)?\s*(?:是|有)?\s*(?:免费|免費|收费|收費|要钱|要錢|吗|嗎)?[\s?？。!！]*$/iu;
const ASK_CONCERN = /(?:在意|担心|擔心|想改善|主要|还是|還是).{0,100}(?:产后|產後)|(?:产后|產後).{0,60}(?:吗|嗎|呢|[?？])/iu;
const ASK_AGE = /(?:生完|生产|生產|分娩|产后|產後).{0,80}(?:多久|多长|多長|几年|幾年|时间|時間|了呢|了吗|了嗎|[?？])/iu;

function isContinuedTreatmentPriceQuestion(text) {
  const current = String(text || "").trim();
  return current.length > 0 && current.length <= 60 &&
    (SESSION_AMOUNT.test(current) ||
      /^(?:请问|請問)?\s*(?:疗程|療程|护理|護理|治疗|治療|rawatan|treatment|service)\s*(?:多少钱|多少錢|几多钱|幾多錢|价钱|價錢|价格|價格|收费|收費|费用|費用|price|cost|harga)[\s?？。!！]*$/iu.test(current) ||
      isStandalonePriceQuestion(current) || isContextualPriceReference(current) ||
      isFirstTrialAmountQuestion(current));
}

function resolveContinuedTreatmentPriceService({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  promotions = [], now = Date.now(),
} = {}) {
  const current = String(customerText || "").trim();
  if (!isContinuedTreatmentPriceQuestion(current) ||
      !hasExplicitPriceRequest(current) || hasClinicalMediaRisk(current) ||
      TOPIC_CHANGE.test(current)) return null;
  const candidates = serviceCandidates(services, serviceAliases);
  if (findServicesInText(current, candidates).length) return null;
  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(x => x?.role === "user" || x?.role === "assistant");
  if (turns.at(-1)?.role !== "user" ||
      typeof turns.at(-1)?.content !== "string" ||
      pricingMessageText(turns.at(-1)).trim() !== current) return null;
  const before = turns.slice(0, -1);
  const customerIndexes = before.flatMap((x, i) => x.role === "user" ? [i] : []).slice(-4);
  const lastAssistant = before.at(-1);
  if (customerIndexes.length < 1 || lastAssistant?.role !== "assistant" ||
      isVerifiedStaffTurn(lastAssistant)) return null;

  for (let pos = customerIndexes.length - 1; pos >= 0; pos--) {
    const index = customerIndexes[pos];
    const source = pricingMessageText(before[index]).trim();
    if (typeof before[index]?.content !== "string" || !source ||
        TOPIC_CHANGE.test(source)) return null;
    const named = safeServiceFromCustomer(source, services, serviceAliases);
    const mentions = findServicesInText(source, candidates);
    if (!named || mentions.length !== 1 || named.name !== mentions[0] ||
        !/(?:有兴趣|有興趣|感兴趣|感興趣|想了解|想知道|想问|想問|interested|enquir|inquir|berminat|nak\s+tahu|mahu\s+tahu)/iu.test(source)) continue;
    if (hasClinicalMediaRisk(source) || !currentPricePackageOptions(named.name, promotions).length ||
        !isRecentPricingThread(turns, index, now)) return null;
    // A Before & After caption may be the latest assistant turn and say only
    // "体态". Require the customer's independently named service to appear
    // in at least one assistant response in the same uninterrupted exchange.
    // Do not use an ad name, CRM field or model label as the sole anchor.
    const nextCustomerIndex = before.findIndex((turn, i) =>
      i > index && turn.role === "user");
    const assistantAfterChoice = before.slice(
      index + 1, nextCustomerIndex < 0 ? before.length : nextCustomerIndex
    );
    if (!assistantAfterChoice.length || assistantAfterChoice.length > 4 ||
        assistantAfterChoice.some(turn =>
          turn.role !== "assistant" || isVerifiedStaffTurn(turn) ||
          !pricingMessageText(turn).trim()) ||
        !assistantAfterChoice.some(turn => {
          const response = pricingMessageText(turn);
          return response.includes(named.name) ||
            (named.name === "骨盆调理" && response.includes("骨盆"));
        })) return null;
    for (let i = index + 1; i < before.length; i++) {
      const turn = before[i], value = pricingMessageText(turn).trim();
      if (!value || isVerifiedStaffTurn(turn)) return null;
      if (turn.role !== "user") continue;
      if (typeof turn.content !== "string") return null;
      if (TOPIC_CHANGE.test(value)) return null;
      // Several automatic Before & After captions may follow the previous
      // answer. A fee question can still refer to its earlier assessment
      // invitation, but must never cross a different customer or STAFF turn.
      let previousCustomer = i - 1;
      while (previousCustomer >= 0 && before[previousCustomer].role !== "user")
        previousCustomer--;
      const replies = before.slice(previousCustomer + 1, i);
      if (!replies.length || replies.length > 4 ||
          replies.some(x => x.role !== "assistant" ||
            isVerifiedStaffTurn(x) || !pricingMessageText(x).trim())) return null;
      const question = replies.map(pricingMessageText).join("\n");
      if (FREE_ASSESSMENT.test(value) && /(?:评估|評估|体验|體驗)/iu.test(question)) continue;
      if (CONCERN_ANSWER.test(value) && ASK_CONCERN.test(question)) continue;
      if (AGE_ANSWER.test(value) && ASK_AGE.test(question)) continue;
      return null;
    }
    return named;
  }
  return null;
}

// A customer can answer an automated appointment question ("weekday") AND
// ask for the treatment's price in the same message. Do not mistake that for
// a new service enquiry, but never use CRM/ad/model guesses as price authority.
//
// This path is deliberately narrower than ordinary price-context carryover:
// - real, recent customer-authored single-treatment choice + bot confirmation
// - immediate bot question about scheduling
// - current customer message both answers scheduling AND explicitly asks price
// - no staff intervention, topic switch, ambiguity or stale conversation
// - trusted conversationStore timestamps for every turn
const BOOKING_RESPONSE_WITH_PRICE =
  /(?:\b(?:weekdays?|weekends?|working\s+days?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\b|平日|平时|平時|周末|週末|工作日|星期[一二三四五六日天]|礼拜[一二三四五六日天])/iu;
const BOOKING_TIME_QUESTION =
  /(?:\b(?:weekday|weekend|available|availability|which\s+day|what\s+day|when|appointment|booking|time\s+slot)\b|平日|平时|平時|周末|週末|哪天|哪一[天日]|星期几|星期幾|几时|幾時|时段|時段|什么时候|什麼時候|哪(?:个|個)?时间|哪(?:个|個)?日期|预约|預約)/iu;
const OTHER_PRICE_SUBJECT =
  /(?:其他|其它|另外|别的|別的|不(?:是|要|想)|another|other|different)\s*(?:疗程|療程|治疗|治療|护理|護理|项目|項目|package|treatment|service|rawatan)/iu;

function resolveBookingResponsePriceService({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  now = Date.now(),
} = {}) {
  const current = String(customerText || "").trim();
  if (!current || current.length > 115 || !BOOKING_RESPONSE_WITH_PRICE.test(current) ||
      !hasExplicitPriceRequest(current) || hasClinicalMediaRisk(current) ||
      TOPIC_CHANGE.test(current) || TOPIC_RESET.test(current) ||
      OTHER_PRICE_SUBJECT.test(current) || BROAD_PRICE_QUESTION.test(current) ||
      !Number.isFinite(now)) return null;

  const candidates = serviceCandidates(services, serviceAliases);
  // Current message must refer back to a treatment, never name a new one.
  if (findServicesInText(current, candidates).length) return null;

  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(x => x?.role === "user" || x?.role === "assistant");
  if (turns.length < 3 || turns.length > 30 ||
      turns.at(-1)?.role !== "user" ||
      typeof turns.at(-1).content !== "string" ||
      turns.at(-1).content.trim() !== current ||
      turns.at(-2)?.role !== "assistant" ||
      isVerifiedStaffTurn(turns.at(-2)) ||
      !BOOKING_TIME_QUESTION.test(pricingMessageText(turns.at(-2)))) return null;

  // Scope the search to a small, uninterrupted conversation, not the entire
  // account's earlier sales history. The most recent customer-selected
  // treatment must match any single-service anchor in the scheduling prompt.
  const latest = turns.slice(-16);
  for (let i = latest.length - 2; i >= 0; i--) {
    const turn = latest[i];
    const text = pricingMessageText(turn).trim();
    if (turn.role === "assistant") {
      if (isVerifiedStaffTurn(turn)) return null;
      continue;
    }
    if (typeof turn.content !== "string" || !text ||
        TOPIC_CHANGE.test(text) || TOPIC_RESET.test(text) ||
        OTHER_PRICE_SUBJECT.test(text) || hasClinicalMediaRisk(text)) return null;
    const mentions = findServicesInText(text, candidates);
    const selected = safeServiceFromCustomer(text, services, serviceAliases);
    if (mentions.length > 1 || (mentions.length && (!selected ||
        mentions[0] !== selected.name))) return null;
    if (!selected) {
      // The immediate booking assistant must follow a customer topic,
      // not a long chain of unrelated user messages.
      if (!/(?:\b(?:weekday|weekend)\b|平日|周末|週末|星期|时间|時間|价钱|價錢|价格|價格|price|harga|多少钱|多少錢|骨盆|体态|體態|脸|臉)/iu.test(text)) return null;
      continue;
    }
    // Real DB timestamps are mandatory to carry commercial context.
    const globalIndex = turns.length - latest.length + i;
    if (!isRecentPricingThread(turns, globalIndex, now)) return null;
    const assistantServices = findServicesInText(
      pricingMessageText(turns.at(-2)), candidates
    );
    if (assistantServices.length !== 1 ||
        assistantServices[0] !== selected.name) return null;
    return selected;
  }
  return null;
}

// Narrow legacy-safe case: the current amount question immediately follows
// the FIRST customer-authored treatment selection, with only recent automated
// assistant replies/photos between them. Unlike the extended assessment thread,
// there may be no intervening customer turns and no staff messages.
function resolveRecentFirstTreatmentPriceService(args = {}) {
  const turns = (Array.isArray(args.conversationHistory) ?
    args.conversationHistory : []).filter(x =>
    x?.role === "user" || x?.role === "assistant");
  if (turns.filter(x => x.role === "user").length !== 2 ||
      turns.at(0)?.role !== "user" ||
      turns.at(-1)?.role !== "user") return null;
  return resolveContinuedTreatmentPriceService(args);
}

function resolveVerifiedPriceFollowUpService({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  promotions = [], allowContinuedPriceContext = false,
} = {}) {
  const current = String(customerText || "").trim();
  if (!current || current.length > 115 ||
      !(hasExplicitPriceRequest(current) || isStandalonePriceQuestion(current)) ||
      TOPIC_RESET.test(current) || BROAD_PRICE_QUESTION.test(current)) return null;

  const bookingResponse = resolveBookingResponsePriceService({
    customerText: current, conversationHistory, services, serviceAliases,
  });
  if (bookingResponse) return bookingResponse;

  if (allowContinuedPriceContext === true) {
    const continued = resolveContinuedTreatmentPriceService({
      customerText: current, conversationHistory, services, serviceAliases, promotions,
    });
    if (continued) return continued;
  }
  // Applies in Off/Shadow only to the first customer-selected treatment
  // and its immediately following direct price question. This does not
  // activate the broader multi-turn assessment recovery.
  const firstPrice = resolveRecentFirstTreatmentPriceService({
    customerText: current, conversationHistory, services, serviceAliases, promotions,
  });
  if (firstPrice) return firstPrice;
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
      // Only a standalone price follow-up, an explicit reference to "this/
      // that" treatment, or a named package can inherit the earlier service.
      // A new unconfigured subject ("按摩多少钱?", "massage price?") is a new
      // enquiry, not permission to quote the previous pelvic treatment.
      const namesCurrentPackage = findMentionedPromotionPackages(options, current).length > 0;
      if (!isStandalonePriceQuestion(current) &&
          !isContextualPriceReference(current) &&
          !namesCurrentPackage) return null;
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
  isContextualPriceReference, isContinuedTreatmentPriceQuestion,
  pricingMessageText, isVerifiedStaffTurn, isRecentPricingThread,
  resolveContinuedTreatmentPriceService, resolveVerifiedPriceFollowUpService,
  resolveRecentFirstTreatmentPriceService, resolveBookingResponsePriceService,
};
