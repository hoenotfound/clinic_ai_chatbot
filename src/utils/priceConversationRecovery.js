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
const TWO_REQUEST = /(?:[这這]?[两兩]\s*(?:个|個|项|項|种|種|页|頁|款)(?:护理|護理|疗程|療程|服务|服務)?|[这這]?2\s*(?:个|個|项|項|种|種|款)(?:护理|護理|疗程|療程|服务|服務)?|\b(?:both|two\s+(?:(?:different|separate)\s+)?(?:treatments?|services?|prices?))\b|(?:3\s*d.{0,12}(?:和|与|與|及|and).{0,12}9\s*d|9\s*d.{0,12}(?:和|与|與|及|and).{0,12}3\s*d))/iu;
const NON_TREATMENT_COUNT = /(?:[这這]?[两兩]|[这這]?2)\s*(?:个|個)?\s*(?:半\s*)?(?:小时|小時|钟头|鐘頭|周|週|星期|礼拜|月|年|天|次|回|人|位)/iu;
const COMBO = /(?:3\s*d\s*[+＋&]\s*9\s*d|9\s*d\s*[+＋&]\s*3\s*d|组合|組合|\b(?:combo|bundle)\b)/iu;
const CLARIFICATION = /(?:哪.{0,22}(?:疗程|療程|价钱|價錢|价格|價格|收费|收費)|想了解哪.{0,40}(?:价格|价钱|價錢)|\b(?:which|what)\b.{0,65}\b(?:treatment|price|cost)\b)/iu;
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
    if (face && preceding.some(turn => turn.role === "assistant" &&
        !isVerifiedStaffTurn(turn) &&
        findServicesInText(pricingMessageText(turn), serviceCandidates(services, aliases))
          .includes(face.name))) return face;
  }
  return null;
}

function recentTurns(session, now) {
  if (!Array.isArray(session) || session.length < 3) return null;
  const last = session.at(-1);
  if (last?.role !== "user" || !isRecentPricingThread(session,0,now) ||
      session.some(turn => isVerifiedStaffTurn(turn) ||
        (turn.role === "user" && hasClinicalMediaRisk(pricingMessageText(turn))))) return null;
  return session.filter(turn => turn.pricingCreatedAtMs >= now - MAX_CONTEXT_MS);
}

// "3D" or "调整大小脸" after a price question and one or more bot
// clarification/menu turns. Unlike the old immediate 3-turn rule, this allows
// the customer to ask for options before selecting ONE verified treatment.
function resolveRecentPriceSelection({
  customerText, session = [], services = [], serviceAliases = [], now = Date.now(),
} = {}) {
  const turns = recentTurns(session, now);
  const current = String(customerText || "").trim();
  if (!turns || turns.length < 4 || !current || current.length > 90 ||
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

// A customer may refer to "those two" only while the two-service menu is
// the ACTIVE subject. A later customer-selected service or a new bot
// explanation of another treatment invalidates the older menu.
function activeTwoServiceMenu(before, candidates) {
  const latest = before.slice(-9);
  for (let index = latest.length - 1; index >= 0; index--) {
    const turn = latest[index];
    const content = pricingMessageText(turn).trim();
    if (!content) return null;
    if (turn.role === "user") {
      if (RESET.test(content) || BROAD.test(content) ||
          hasClinicalMediaRisk(content) ||
          findServicesInText(content, candidates).length) return null;
      // Unrelated new questions make an old two-treatment menu stale.
      if (/^(?:地址|位置|在哪里|在哪裡|location|address|where|预约|預約|booking|slot)/iu.test(content))
        return null;
      continue;
    }
    if (turn.role !== "assistant" || isVerifiedStaffTurn(turn)) return null;
    const names = separateServicesInMenu(content, candidates);
    if (names.length === 2) return names;
    // A later assistant explanation or menu involving another treatment
    // supersedes the earlier pair; never search past it for an old menu.
    if (names.length || findServicesInText(content,candidates).length) return null;
  }
  return null;
}

function requestedTwoTreatmentServices(current, before, services, aliases) {
  const candidates = serviceCandidates(services, aliases);
  const directNames = [...new Set(findServicesInText(current, candidates))];
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
  const turns = recentTurns(session, now);
  const current = String(customerText || "").trim();
  if (!turns || !current || current.length > 115 || !TWO_REQUEST.test(current) ||
      NON_TREATMENT_COUNT.test(current) ||
      RESET.test(current) || BROAD.test(current) || ADMIN_FEE.test(current) ||
      COMBO.test(current) || pricingMessageText(turns.at(-1)).trim() !== current)
    return null;
  const before = turns.slice(0,-1);
  const direct = hasExplicitPriceRequest(current);
  if (!direct) {
    // A bare "两个" only continues an immediately unresolved price enquiry
    // which *already asked about two* and led to the bot's clarification.
    if (!/^(?:(?:两|兩)\s*(?:个|個|项|項|页|頁)(?:都要|都想了解|都想知道)?|both(?:\s+(?:please|of them))?)[\s!！。?？]*$/iu.test(current) ||
        before.at(-1)?.role !== "assistant" ||
        !CLARIFICATION.test(pricingMessageText(before.at(-1))) ||
        !before.filter(x => x.role === "user").slice(-2)
          .some(x => TWO_REQUEST.test(pricingMessageText(x)) &&
            hasExplicitPriceRequest(pricingMessageText(x)))) return null;
  }
  const names = requestedTwoTreatmentServices(
    current, before, services, serviceAliases
  );
  if (!names || names.length !== 2) return null;

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

module.exports = {
  resolveRecentPriceSelection, resolveEstablishedTreatmentPrice,
  resolveTwoTreatmentPriceReply,
};
