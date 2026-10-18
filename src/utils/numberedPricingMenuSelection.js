"use strict";

const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const {
  pricingMessageText, isVerifiedStaffTurn, isRecentPricingThread,
} = require("./priceFollowUpContext");

// A bare digit is an answer only to the bot's IMMEDIATELY preceding numbered
// treatment menu. Neither ad names nor old CRM interest can reinterpret it.
const NUMBER = /^[1-9]$/u;
// Rendered AI menus often use "1. 骨盆/体态调理（适合产后...）"
 // without a colon. Match complete numbered lines; authorize from the
 // verified heading only, never free-form assistant description text.
const MENU_ENTRY = /^\s*([1-9])\s*[.)、．]\s*([^\r\n]{2,160})\s*$/gmu;
const TREATMENT_LIST_REQUEST =
  /(?:哪[几幾种種项項]|有哪[几幾种種類]|有什[么麼](?:疗程|療程|服务|服務|项目|項目)|(?:what|which)\s+(?:treatments?|services?|options?)|(?:senarai|jenis)\s+(?:rawatan|servis))/iu;
const PRICE_MENU_QUESTION =
  /(?:哪.{0,40}(?:价格|價格|价钱|價錢|收费|收費|费用|費用)|(?:价格|價錢|价钱|收费|收費|费用|費用).{0,40}哪|\b(?:which|what)\b.{0,60}\b(?:price|cost|fee)\b|\b(?:harga)\b.{0,60}\b(?:mana|apa)\b)/iu;
const ADMIN_FEE =
  /(?:订金|訂金|定金|按金|押金|挂号|掛號|注册|註冊|停车|停車|咨询费|諮詢費|评估费|評估費|预约费|預約費|(?:免费|免費).{0,24}(?:评估|評估|体验|體驗).{0,30}(?:多少钱|多少錢|收费|收費|费用|費用|价钱|價錢|价格|要钱|要錢)|\b(?:deposit|booking fee|consultation fee|assessment fee|registration fee|parking fee)\b)/iu;

// This routine is intentionally narrower than general AI intent recognition:
// - a recent, DB-timestamped user price question;
// - a direct bot pricing menu OR an intervening treatment-list request;
// - an assistant-authored, numbered menu ending in a pricing clarification;
// - a single digit that maps to one currently configured service.
// If any evidence is missing, the ordinary conversation route takes over.
function resolveNumberedPricingMenuSelection({
  customerText, conversationHistory = [], services = [], serviceAliases = [],
  now = Date.now(),
} = {}) {
  const number = String(customerText || "").normalize("NFKC").trim();
  if (!NUMBER.test(number) || hasClinicalMediaRisk(number)) return null;
  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(entry => entry?.role === "assistant" || entry?.role === "user");
  if (turns.length < 3) return null;
  const current = turns.at(-1), menu = turns.at(-2), previous = turns.at(-3);
  // Either:
  //   price question -> bot's numbered pricing menu -> chosen digit, OR
  //   price question -> bot clarification -> customer requests options ->
  //   bot's numbered pricing menu -> chosen digit.
  // Never accept a digit based solely on an old menu or a verified ad.
  const directPriceMenu = previous?.role === "user" &&
    hasExplicitPriceRequest(pricingMessageText(previous));
  const requestedList = previous?.role === "user" &&
    TREATMENT_LIST_REQUEST.test(pricingMessageText(previous));
  if (current?.role !== "user" || pricingMessageText(current).trim() !== number ||
      menu?.role !== "assistant" || isVerifiedStaffTurn(menu) ||
      (!directPriceMenu && !requestedList)) return null;
  const menuText = pricingMessageText(menu);
  if (!PRICE_MENU_QUESTION.test(menuText.slice(-170))) return null;
  const options = [...menuText.matchAll(MENU_ENTRY)];
  if (options.length < 2 || options.length > 9 ||
      new Set(options.map(option => option[1])).size !== options.length) return null;
  const matching = options.filter(option => option[1] === number);
  if (matching.length !== 1) return null;

  // A mixed option may advertise two separate services (3D/9D), so it
  // must never be reduced to its first treatment. The existing single
  // pelvic/posture menu label is an explicitly recognized description,
  // not permission to guess the first part of arbitrary mixed headings.
  const fullEntry = matching[0][2].trim();
  // The description is informational, not an independent service choice.
  // A line with multiple configured treatments remains ambiguous even when
  // the first phrase looks like the usual pelvic label.
  const dividerAt = fullEntry.search(/[：:（(]/u);
  const heading = (dividerAt < 0 ? fullEntry : fullEntry.slice(0, dividerAt)).trim();
  const description = dividerAt < 0 ? "" : fullEntry.slice(dividerAt);
  const singlePelvicDescription = /^骨盆\s*[\/／]\s*体态调理$/u.test(heading);
  if (/[\/／+＋&＆、]|(?:\s*及\s*|\s*和\s*|\s*与\s*)/u.test(heading) &&
      !singlePelvicDescription) return null;
  const resolvedText = singlePelvicDescription ? "骨盆调理" : heading;
  const selected = safeServiceFromCustomer(resolvedText, services, serviceAliases);
  if (!selected) return null;
  const candidates = serviceCandidates(services, serviceAliases);
  // "适合产后" describes the target audience, not a second service.
  // Neutro also has a bare "产后" alias for the separate 产后调理 service;
  // do not misread that demographic phrase as a mixed-treatment menu entry.
  // Explicit "产后调理/疗程/护理" remains a conflicting service.
  const treatmentDescription = description.replace(
    /(?:适合|適合|针对|針對|适用于|適用於)\s*(?:产后|產後)(?!\s*(?:调理|調理|疗程|療程|护理|護理))/gu,
    ""
  );
  if (findServicesInText(treatmentDescription, candidates)
    .some(name => name !== selected.name)) return null;

  if (directPriceMenu) {
    const amountText = pricingMessageText(previous).trim();
    if (hasClinicalMediaRisk(amountText) || ADMIN_FEE.test(amountText) ||
        !isRecentPricingThread(turns, turns.length - 3, now)) return null;
  } else {
    const beforeMenu = turns.slice(0, -3);
    const earlierCustomer = beforeMenu.map((turn, index) =>
      turn.role === "user" ? index : -1).filter(index => index !== -1).at(-1);
    if (earlierCustomer == null) return null;
    const earlierPrice = pricingMessageText(beforeMenu[earlierCustomer]).trim();
    if (!hasExplicitPriceRequest(earlierPrice) ||
        hasClinicalMediaRisk(earlierPrice) || ADMIN_FEE.test(earlierPrice) ||
        !isRecentPricingThread(turns, earlierCustomer, now)) return null;

    // Staff, unrelated topics and ambiguous media between a customer's
    // original price enquiry and a requested treatment menu end carryover.
    const bridge = turns.slice(earlierCustomer + 1, -3);
    if (bridge.length > 2 || bridge.some(turn =>
      turn.role !== "assistant" || isVerifiedStaffTurn(turn) ||
      !pricingMessageText(turn).trim())) return null;
  }
  return { treatment: selected.name, source: "numbered_price_menu" };
}

module.exports = { resolveNumberedPricingMenuSelection };
