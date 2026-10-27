"use strict";

// Recover customer-authored pricing context without treating a model, CRM field,
// old ad or the assistant's menu alone as consent to quote. This module is
// deliberately read-only: pricing media and provider sends remain in server.js.
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { verifiedPricesForService } = require("./verifiedPriceReply");
const { getActivePromotions } = require("./activePromotion");
const { pricingMessageText, isVerifiedStaffTurn, isRecentPricingThread } = require("./priceFollowUpContext");

const MAX_CONTEXT_MS = 3 * 60 * 60 * 1000;
const RESET = /(?:换个|換個|改聊|不聊|其他话题|其他話題|另外想|想改做|改做其他|改做其它|改选|改選|其他疗程|其它疗程|其他療程|其它療程|不要|不想(?:做|了解)|退订|退訂|\b(?:stop|unsubscribe|opt\s*out|switch|instead|another\s+treatment|not\s+interested|don't\s+want)\b)/iu;
const BROAD = /(?:全院|全部(?:疗程|療程|服务|服務|价目|價目)|所有(?:疗程|療程|服务|服務|项目|項目)|\b(?:all\s+(?:treatments?|services?)|whole\s+clinic|price\s+list)\b)/iu;
const ADMIN_FEE = /(?:押金|订金|訂金|定金|评估|評估|咨询费|諮詢費|挂号|掛號|booking\s+fee|deposit|assessment\s+fee|consultation\s+fee)/iu;
// Count *distinct treatments*, never two hours, visits, sessions or an RM amount.
const TWO_REQUEST = /(?:[这這]?[两兩]\s*(?:个|個|项|項|种|種|页|頁|款)(?:护理|護理|疗程|療程|服务|服務)?|[这這]?2\s*(?:个|個|项|項|种|種|款)(?:护理|護理|疗程|療程|服务|服務)?|\b(?:both|two\s+(?:(?:different|separate)\s+)?(?:treatments?|services?|prices?))\b|(?:3\s*d.{0,12}(?:和|与|與|及|跟|、|\/|and|dan).{0,12}9\s*d|9\s*d.{0,12}(?:和|与|與|及|跟|、|\/|and|dan).{0,12}3\s*d)|(?:3\s*d\s+9\s*d|9\s*d\s+3\s*d).{0,20}(?:分开|分開|分别|分別|各自|单独|單獨|separately|each))/iu;
const NON_TREATMENT_COUNT = /(?:[这這]?[两兩]|[这這]?2)\s*(?:个|個)?\s*(?:半\s*)?(?:小时|小時|钟头|鐘頭|周|週|星期|礼拜|月|年|天|次|回|人|位)/iu;
const OMIT_COMBO = /(?:不要|不想要?|不需要|不选|不選|不是|不用)\s*(?:(?:3\s*d\s*[+＋&]\s*9\s*d|9\s*d\s*[+＋&]\s*3\s*d)\s*)?(?:组合|組合|搭配|combo|bundle)(?:配套|套餐|价|價|价格|價格)?|\b(?:not\s+(?:the\s+)?|no\s+|don't\s+want\s+(?:the\s+)?|without\s+(?:the\s+)?)\s*(?:combo|bundle)\b|\b(?:bukan|tak\s+nak|tidak\s+mahu)\s*(?:pakej|combo|bundle)\b/giu;
const COMBO = /(?:3\s*d\s*[+＋&]\s*9\s*d|9\s*d\s*[+＋&]\s*3\s*d|组合|組合|\b(?:combo|bundle)\b)/iu;
// "3D 和 9D 一起做多少钱" asks for a JOINT price, not two
// independent First Trial prices. The combo has no verified price, so fail
// closed even when the user also mentions individual prices in the same turn.
// Only price-intent text is passed to the final two-quote resolver.
const JOINT_PRICE_INTENT = /(?:一起|一齐|一齊|一同|同时|同時|一并|一併|一块|一塊)\s*(?:做|进行|進行|护理|護理|治疗|治療|体验|體驗|安排|买|買|算|计算|計算|收费|收費|的?\s*(?:价格|價格|价钱|價錢|多少钱|多少錢))|(?:一起|一齐|一齊)\s*(?:是|要|的)?\s*(?:多少钱|多少錢|几多钱|幾多錢|价钱|價錢|价格|價格)|(?:加起来|加起來|加埋|合起来|合起來|一共|总共|總共|合计|合計|总价|總價|打包价|打包價)|\b(?:together|combined|jointly|joint|total\s+(?:price|cost|charge|amount)|both\s+(?:at\s+once|in\s+(?:one|the\s+same)\s+(?:session|visit))|at\s+the\s+same\s+time)\b|\b(?:gabung(?:an)?|serentak|sekaligus|sekali\s+gus|dua[-\s]*dua\s+sekali|buat\s+(?:dua[-\s]*dua\s+)?sekali|jumlah\s+(?:harga|kos|untuk\s+(?:dua|kedua)))\b/iu;
const CLARIFICATION = /(?:哪.{0,22}(?:疗程|療程|价钱|價錢|价格|價格|收费|收費)|想了解哪.{0,40}(?:价格|价钱|價錢)|\b(?:which|what)\b.{0,65}\b(?:treatment|price|cost)\b)/iu;
const MENU_PRICE_QUESTION = /(?:价钱|價錢|价格|價格|收费|收費|费用|費用|价格|多少钱|多少錢|price|cost|harga)/iu;
const MENU_SELECTION_QUESTION = /(?:请问|請問|哪|选|選|想了解|想知道|想问|想問|which|what|would\s+you\s+like)/iu;
const MULTIPLE_PACKAGES = /(?:package\s*[ab]|配套\s*[ab]|套餐\s*[ab]|(?:两|兩|二|2)\s*(?:个|個|项|項|种|種|套|款)?\s*(?:配套|套餐|方案|packages?|pakej)|(?:which|what)\s+packages?|哪(?:个|個|一[个個款项項])\s*(?:配套|套餐|方案)|(?:各有|都有|每(?:个|個)项目|每(?:个|個)疗程).{0,14}(?:配套|套餐|方案|packages?|pakej))/iu;
const SEPARATE_PRICE = /(?:分开|分開|分别|分別|各自|单独|單獨|individually|separately|separate\s+prices?|each|asing[- ]asing)/iu;
const SHORT_BOTH = /^(?:(?:这|這)?(?:两|兩)\s*(?:个|個|项|項|页|頁)(?:都要|都想了解|都想知道)?|both(?:\s+(?:please|of them))?)[\s!！。?？]*$/iu;
const CONCERN_3D = /^(?:(?:我想|想|要|做)\s*)?(?:调整|調整|改善|处理|處理)?\s*(?:左右)?\s*大小脸(?:的视觉|視覺|视觉|問題|问题)?[\s!！。?？]*$/u;

function namedSingle(text, services, aliases) {
  const content = String(text || "").trim();
  const candidates = serviceCandidates(services, aliases);
  const matches = [...new Set(findServicesInText(content, candidates))];
  if (matches.length > 1) return null;
  const selected = safeServiceFromCustomer(content, services, aliases);
  if (selected && matches.length === 1 && matches[0] === selected.name) return selected;
  return null;
}

function shortChoice(text, services, aliases, preceding) {
  const selected = namedSingle(text, services, aliases);
  if (selected) return selected;
  // "3D" / "9D" are user choices only in an active treatment-price thread
  // where the bot independently named that single matching configured service.
  const short = /^(?:3|9)\s*d[\s.。?？!！]*$/iu.exec(String(text || "").trim());
  if (short) {
    const prefix = short[0].trim().slice(0,1) + "D";
    const found = services.filter(s => !COMBO.test(s.name) &&
      new RegExp("^" + prefix + "(?:\\b|\\s)", "iu").test(s.name));
    if (found.length === 1 && preceding.some(turn => turn.role === "assistant" &&
        !isVerifiedStaffTurn(turn) &&
        findServicesInText(pricingMessageText(turn), serviceCandidates(services, aliases))
          .includes(found[0].name))) return found[0];
  }
  // A concern description is not a general alias. It is valid only when a
  // specific earlier customer PRICE request is awaiting clarification and
  // the bot has independently explained 3D in this very thread.
  if (CONCERN_3D.test(String(text || "").trim())) {
    const face = services.find(s => s.name === "3D 小颜术");
    const candidates = serviceCandidates(services, aliases);
    // Trust an explicit bot explanation connecting 3D with the customer's
    // size/asymmetry concern, not a generic menu that merely names 3D and 9D.
    const botMappedConcern = preceding.some(turn => turn.role === "assistant" &&
      !isVerifiedStaffTurn(turn) &&
      pricingMessageText(turn).split(/[，,。；;!！?？\n]/u).some(clause =>
        /大小脸/u.test(clause) &&
        findServicesInText(clause, candidates).length === 1 &&
        findServicesInText(clause, candidates)[0] === face?.name
      ));
    // Or the customer established the size concern before a bot explained
    // 3D in direct response (and there is no competing service in that reply).
    const priorConcernConfirmed = preceding.some((turn, index) => {
      if (turn.role !== "user" || !/大小脸/u.test(pricingMessageText(turn))) return false;
      const next = preceding[index + 1];
      if (next?.role !== "assistant" || isVerifiedStaffTurn(next)) return false;
      const mentioned = [...new Set(findServicesInText(pricingMessageText(next), candidates))];
      return mentioned.length === 1 && mentioned[0] === face?.name;
    });
    // An explicit newer customer treatment choice supersedes the older
    // facial explanation; a newer 9D choice cannot silently become 3D.
    const namedSelections = preceding.filter(turn => turn.role === "user")
      .map(turn => [...new Set(findServicesInText(pricingMessageText(turn), candidates))])
      .filter(names => names.length > 0);
    const latestSelection = namedSelections.at(-1);
    if (latestSelection && (latestSelection.length !== 1 ||
        latestSelection[0] !== face?.name)) return null;
    if (face && (botMappedConcern || priorConcernConfirmed)) return face;
  }
  return null;
}

function recentTurns(session, now) {
  if (!Array.isArray(session) || session.length < 3) return null;
  const last = session.at(-1);
  if (last?.role !== "user" || !isRecentPricingThread(session,0,now) ||
      session.some(turn => isVerifiedStaffTurn(turn) ||
        (turn.role === "user" && hasClinicalMediaRisk(pricingMessageText(turn))))) return null;
  const bounded = session.filter(turn => turn.pricingCreatedAtMs >= now - MAX_CONTEXT_MS);
  // No orphan assistant menu may authorize a quote after the 3h cutoff.
  const firstUser = bounded.findIndex(turn => turn.role === "user");
  return firstUser < 0 ? null : bounded.slice(firstUser);
}

// "3D" or "调整大小脸" after a price question and one or more bot
// clarification/menu turns. Unlike the old immediate 3-turn rule, this allows
// the customer to ask for options before selecting ONE verified treatment.
function resolveRecentPriceSelection({
  customerText, session = [], services = [], serviceAliases = [], now = Date.now(),
} = {}) {
  const turns = recentTurns(session, now);
  const current = String(customerText || "").trim();
  if (!turns || turns.length < 3 || !current || current.length > 90 ||
      RESET.test(current) || BROAD.test(current) || ADMIN_FEE.test(current) ||
      hasExplicitPriceRequest(current) || TWO_REQUEST.test(current) ||
      pricingMessageText(turns.at(-1)).trim() !== current ||
      turns.at(-2)?.role !== "assistant" || isVerifiedStaffTurn(turns.at(-2))) return null;
  const before = turns.slice(0,-1);
  const selected = shortChoice(current, services, serviceAliases, before.slice(-12));
  if (!selected) return null;
  const customers = before.filter(turn => turn.role === "user").slice(-5);
  if (!customers.some(turn => hasExplicitPriceRequest(pricingMessageText(turn)) &&
      !ADMIN_FEE.test(pricingMessageText(turn)) &&
      !BROAD.test(pricingMessageText(turn)))) return null;
  if (!before.slice(-10).some(turn => turn.role === "assistant" &&
      !isVerifiedStaffTurn(turn) &&
      (CLARIFICATION.test(pricingMessageText(turn)) ||
        findServicesInText(pricingMessageText(turn),
          serviceCandidates(services,serviceAliases)).includes(selected.name)))) return null;
  // A later customer topic switch or selection of another service supersedes
  // the old price question. Do not borrow an older treatment.
  for (const turn of customers.slice(1)) {
    const text = pricingMessageText(turn);
    if (RESET.test(text) || hasClinicalMediaRisk(text)) return null;
  }
  return selected;
}

// A bare monetary follow-up within a recent customer-led discussion may
// refer to an independently selected treatment even after ordinary Q&A.
// Require bot acknowledgement, bounded trusted timestamps, no staff and no
// competing treatment selection. No ad-only or assistant-only price authority.
function resolveEstablishedTreatmentPrice({
  customerText, session = [], services = [], serviceAliases = [], now = Date.now(),
} = {}) {
  const turns = recentTurns(session, now);
  const current = String(customerText || "").trim();
  if (!turns || !current || current.length > 115 ||
      !hasExplicitPriceRequest(current) || BROAD.test(current) ||
      TWO_REQUEST.test(current) || RESET.test(current) ||
      ADMIN_FEE.test(current) || /\b(?:RM|MYR)\s*[1-9]\d{1,4}\b/iu.test(current) ||
      pricingMessageText(turns.at(-1)).trim() !== current)
    return null;
  const candidates = serviceCandidates(services, serviceAliases);
  const namedNow = findServicesInText(current, candidates);
  if (namedNow.length > 1) return null;
  if (namedNow.length === 1) return namedSingle(current, services, serviceAliases);
  const prior = turns.slice(0, -1);
  // The latest customer-selected service takes priority, never the last
  // service a bot happened to recommend. Reject competing or mixed selections.
  const users = prior.flatMap((turn,index) => turn.role === "user" ? [index] : []).slice(-7);
  for (const index of users.reverse()) {
    const source = pricingMessageText(prior[index]).trim();
    if (!source || RESET.test(source) || BROAD.test(source)) return null;
    const mentions = [...new Set(findServicesInText(source,candidates))];
    if (mentions.length > 1) return null;
    let named = shortChoice(source, services, serviceAliases, prior.slice(Math.max(0,index-7),index));
    if (!named && mentions.length) return null;
    // An asymmetry concern is not an explicit switch from a customer-selected
    // service. Even when a later bot happens to mention 3D in its answer,
    // preserve the latest named customer choice (including a newer 9D).
    if (CONCERN_3D.test(source)) {
      const earlierNames = prior.slice(0, index).filter(turn => turn.role === "user")
        .map(turn => [...new Set(findServicesInText(pricingMessageText(turn), candidates))])
        .filter(names => names.length > 0);
      const latestEarlierNames = earlierNames.at(-1);
      if (latestEarlierNames && (latestEarlierNames.length !== 1 ||
          latestEarlierNames[0] !== "3D 小颜术")) return null;
    }
    // A face concern can establish 3D only when a recent bot explained
    // that configured service (not from an ad name or model guess).
    if (!named && CONCERN_3D.test(source)) {
      // The customer supplied the concern; only a bot reply explaining the
      // matching configured facial treatment may confirm that interpretation.
      // Do not derive a treatment from an advert or old CRM interest.
      const face = services.find(s => s.name === "3D 小颜术");
      const nextAssistant = prior.slice(index + 1).find(turn => turn.role === "assistant");
      const explained = nextAssistant &&
        [...new Set(findServicesInText(pricingMessageText(nextAssistant),candidates))];
      if (face && explained?.length === 1 && explained[0] === face.name) named = face;
    }
    if (!named) continue;
    const since = prior.slice(index + 1);
    // A bot mentioning a different treatment after the customer's selection
    // interrupts the single-service topic. Only a NEW customer selection can
    // then authorize a specific treatment price.
    if (since.some(turn => turn.role === "assistant" &&
      findServicesInText(pricingMessageText(turn),candidates)
        .some(service => service !== named.name))) return null;
    if (!since.some(turn => turn.role === "assistant" &&
        findServicesInText(pricingMessageText(turn),candidates).includes(named.name)))
      continue;
    if (since.some(turn => turn.role === "user" &&
      [...new Set(findServicesInText(pricingMessageText(turn),candidates))]
        .some(service => service !== named.name))) return null;
    return named;
  }
  return null;
}

// Verify which two *individual* services a bot just presented. An optional
// combined package must not be confused with those two services. Split menu
// alternatives so the combo clause does not hide independently listed items.
function separateServicesInMenu(message, candidates) {
  const text = String(message || "");
  const chunks = text.split(/[，,、；;。!！?\n]|\b(?:otherwise|alternatively)\b/iu)
    .flatMap(part => part.split(/(?:另外|或者|也有|还有|还可以|也可以|亦可|\bor\s+also\b)/iu));
  const matched = new Set();
  for (const chunk of chunks) {
    if (COMBO.test(chunk)) continue;
    for (const name of findServicesInText(chunk, candidates)) {
      if (!COMBO.test(name)) matched.add(name);
    }
  }
  return [...matched];
}

// "These two" uses the IMMEDIATELY preceding bot menu, or one
// clarification turn responding to an explicit two-price question. Never
// search through unrelated hours/address/booking discussion to an old menu.
function activeTwoServiceMenu(before, candidates) {
  const latest = before.at(-1);
  if (latest?.role !== "assistant" || isVerifiedStaffTurn(latest)) return null;
  const text = pricingMessageText(latest).trim();
  if (!text || MULTIPLE_PACKAGES.test(text)) return null;
  const latestNames = separateServicesInMenu(text, candidates);
  if (latestNames.length === 2) return latestNames;
  if (latestNames.length || findServicesInText(text, candidates).length ||
      !CLARIFICATION.test(text)) return null;
  const interveningPrice = before.at(-2);
  const earlierMenu = before.at(-3);
  if (interveningPrice?.role !== "user" || earlierMenu?.role !== "assistant" ||
      isVerifiedStaffTurn(earlierMenu)) return null;
  const asked = pricingMessageText(interveningPrice).trim();
  const menu = pricingMessageText(earlierMenu).trim();
  if (!TWO_REQUEST.test(asked) || !hasExplicitPriceRequest(asked) ||
      RESET.test(asked) || BROAD.test(asked) ||
      ADMIN_FEE.test(asked) || COMBO.test(asked) || JOINT_PRICE_INTENT.test(asked) ||
      hasClinicalMediaRisk(asked) || !menu || MULTIPLE_PACKAGES.test(menu))
    return null;
  const names = separateServicesInMenu(menu, candidates);
  return names.length === 2 ? names : null;
}

// The production clinic also aliases "3D+9D" to a combined package. The
// general matcher intentionally normalizes away punctuation, meaning an
// individual-price list "3D、9D分别多少钱" can look exactly like that combo.
 // Only in an EXPLICIT SEPARATE-PRICE question, insert a real word connector
 // between bare service codes before matching. Do not change global matching,
 // the configured aliases or the handling of positive combination requests.
function separatePriceServiceText(text) {
  return String(text || "").replace(
    /\b(3\s*d|9\s*d)\s*(?:、|\/|&|\s+)\s*(9\s*d|3\s*d)\b/giu,
    (whole, first, second) =>
      first.trim().toLowerCase() === second.trim().toLowerCase()
        ? whole : first + " 和 " + second
  );
}

function requestedTwoTreatmentServices(current, before, services, aliases, explicitlySeparate = false) {
  const candidates = serviceCandidates(services, aliases);
  const priceText = explicitlySeparate ? separatePriceServiceText(current) : current;
  const directNames = [...new Set(findServicesInText(priceText, candidates))];
  if (directNames.length > 2 || directNames.some(name => COMBO.test(name))) return null;
  if (directNames.length === 2) return directNames;
  if (directNames.length) return null;
  return activeTwoServiceMenu(before, candidates);
}

// Quote two SEPARATE, active verified treatment offers as TEXT ONLY when
// the customer explicitly asks for both. This is not a combo promotion.
function resolveTwoTreatmentPriceReply({
  customerText, session = [], services = [], serviceAliases = [],
  promotions = [], language = "zh", now = Date.now(),
} = {}) {
  const current = String(customerText || "").trim();
  const turns = recentTurns(session, now) || (
    // A first inbound message explicitly NAMING both configured services and
    // asking their prices is already customer evidence. This narrow exception
    // needs no previous bot menu, but still requires a trusted fresh timestamp.
    Array.isArray(session) && session.length === 1 &&
    session[0]?.role === "user" &&
    isRecentPricingThread(session, 0, now) &&
    session[0].pricingCreatedAtMs >= now - MAX_CONTEXT_MS &&
    !hasClinicalMediaRisk(pricingMessageText(session[0])) &&
    pricingMessageText(session[0]).trim() === current
      ? session : null
  );
  // Removing only a clear NEGATION of the combo lets "3D 和 9D 分开
  // 多少钱？不要组合" mean two independent quotes. Positive combo requests
  // and refusals of treatment itself still fail closed.
  const effective = current.replace(OMIT_COMBO, " ").trim();
  const separate = SEPARATE_PRICE.test(effective);
  const ampersandOnly = /(?:3\s*d\s*&\s*9\s*d|9\s*d\s*&\s*3\s*d)/iu.test(effective) &&
    !/(?:3\s*d\s*[+＋]\s*9\s*d|9\s*d\s*[+＋]\s*3\s*d|组合|組合|\b(?:combo|bundle)\b)/iu.test(effective);
  const comboRequested = (COMBO.test(effective) && !(ampersandOnly && separate)) ||
    JOINT_PRICE_INTENT.test(effective);
  if (!turns || !current || current.length > 115 ||
      !(TWO_REQUEST.test(effective) || (ampersandOnly && separate)) ||
      NON_TREATMENT_COUNT.test(effective) ||
      RESET.test(effective) || BROAD.test(effective) || ADMIN_FEE.test(effective) ||
      comboRequested || pricingMessageText(turns.at(-1)).trim() !== current)
    return null;
  const before = turns.slice(0,-1);
  const direct = hasExplicitPriceRequest(effective);
  if (!direct) {
    // A short "两个" directly answers a PRICE choice between exactly two
    // distinct treatments. Do not require a redundant earlier "both prices"
    // question. Preserve the older continuation when the bot asks a generic
    // clarification following a verified two-price request.
    const precedingBot = before.at(-1);
    const botText = pricingMessageText(precedingBot);
    const choices = separateServicesInMenu(botText, serviceCandidates(services, serviceAliases));
    const explicitMenu = precedingBot?.role === "assistant" &&
      !isVerifiedStaffTurn(precedingBot) &&
      choices.length === 2 && MENU_PRICE_QUESTION.test(botText) &&
      MENU_SELECTION_QUESTION.test(botText) && !MULTIPLE_PACKAGES.test(botText);
    const priorTwoPrice = precedingBot?.role === "assistant" &&
      CLARIFICATION.test(botText) &&
      before.filter(x => x.role === "user").slice(-2)
        .some(x => TWO_REQUEST.test(pricingMessageText(x)) &&
          hasExplicitPriceRequest(pricingMessageText(x)));
    if (!SHORT_BOTH.test(current) || (!explicitMenu && !priorTwoPrice))
      return null;
  }
  const names = requestedTwoTreatmentServices(
    effective, before, services, serviceAliases, separate
  );
  if (!names || names.length !== 2 ||
      (turns.length === 1 && (
        !direct ||
        [...new Set(findServicesInText(
          separate ? separatePriceServiceText(effective) : effective,
          serviceCandidates(services, serviceAliases)))].length !== 2
      ))) return null;

  // Each treatment must have exactly one independently verified active offer.
  // Do not assume the same amount is a combined package amount.
  const active = getActivePromotions(promotions, new Date(now));
  const prices = names.map(name => {
    const matching = active.filter(p =>
      p.linkedService === name && p.sendOnPriceQuery === true
    );
    if (matching.length !== 1) return null;
    const options = verifiedPricesForService(
      name, promotions, current, session, { allowTextOnlyOffers:true }
    );
    if (!Array.isArray(options) || options.length !== 1 ||
        !/^RM[1-9]\d{0,5}$/u.test(String(options[0]?.price || ""))) return null;
    const description = [
      matching[0].name, options[0].name, options[0].title,
      options[0].caption, matching[0].caption,
    ].filter(Boolean).join(" ");
    const firstTrial = /first[\s-]*trial|首次(?:体验|體驗|护理|護理|疗程|療程)|初次(?:体验|體驗)|第一次(?:体验|體驗)/iu.test(description);
    return { treatment:name, amount:options[0].price,
      label: firstTrial ? "first_trial" : "current_offer" };
  });
  if (prices.some(x => !x)) return null;

  const locale = String(language || "").toLowerCase();
  const label = value => value.label === "first_trial"
    ? locale.startsWith("en") ? "First Trial"
      : locale.startsWith("ms") ? "Harga First Trial" : "First Trial 体验价"
    : locale.startsWith("en") ? "Current offer"
      : locale.startsWith("ms") ? "Harga promosi semasa" : "当前优惠价";
  const reply = locale.startsWith("en")
    ? "Here are the prices for the two separate treatments:\n" +
      prices.map(x => "• " + x.treatment + " (" + label(x) + "): " + x.amount).join("\n") +
      "\nThese are individual treatment offers, not a combination package."
    : locale.startsWith("ms")
      ? "Harga untuk dua rawatan berasingan ialah:\n" +
        prices.map(x => "• " + x.treatment + " (" + label(x) + "): " + x.amount).join("\n") +
        "\nIni harga untuk setiap rawatan, bukan pakej gabungan."
      : "这两项护理各自的价格是：\n" +
        prices.map(x => "• " + x.treatment + "（" + label(x) + "）：" + x.amount).join("\n") +
        "\n以上是两项分开的优惠，不是组合配套哦 😊";
  return { prices, reply, source:"verified_two_separate_treatments" };
}

// Only a verified current dual quote may dismiss a model INFORMATION review.
// The real DB clinical-review read is performed by the caller immediately
// before this check; missing evidence never counts as no clinical risk.
function canRecoverTwoPriceInformationReview({
  quote = null, flagged = false, reviewRequired = false,
  reviewType = null, pendingClinicalReview = null,
} = {}) {
  return Boolean(quote?.prices?.length === 2 &&
    flagged === true && reviewRequired === true &&
    reviewType === "information" && pendingClinicalReview === false);
}

module.exports = {
  resolveRecentPriceSelection, resolveEstablishedTreatmentPrice,
  resolveTwoTreatmentPriceReply, canRecoverTwoPriceInformationReview,
};
