"use strict";

// Offer Neutro's separately configured 3D + 9D package without conflating
// two individual First Trial prices with the price of one combined package.
// This only formats verified text. It does not authorize promotional media.
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { getActivePromotions } = require("./activePromotion");
const { verifiedPricesForService } = require("./verifiedPriceReply");
const { isVerifiedStaffTurn } = require("./priceFollowUpContext");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");

const COMBO_SERVICE = "3D + 9D 组合";
const INDIVIDUAL_SERVICES = new Set(["3D 小颜术", "9D 逆龄抗衰"]);
const MAX_CONTEXT_MS = 3 * 60 * 60 * 1000;
const REJECT = /(?:退订|退訂|不要再发|不要再發|停止发|停止發|不想(?:做|了解)|不需要(?:治疗|治療|护理|護理)|\b(?:stop\s+(?:messag|promot)|opt[ -]?out|unsubscribe|not\s+interested)\b)/iu;
const NO_COMBO = /(?:不要|不想要?|不需要|不选|不選|不用|不是)\s*(?:3\s*d\s*[+＋]\s*9\s*d\s*)?(?:组合|組合|搭配|combo|bundle)|\b(?:no|not|without|bukan|tak\s+nak)\s+(?:the\s+)?(?:combo|bundle|pakej)\b/iu;
const ADMIN_PRICE = /(?:押金|订金|訂金|定金|咨询费|諮詢費|挂号|掛號|评估费|評估費|booking\s+fee|deposit|assessment\s+fee|consultation\s+fee)/iu;
const BROAD = /(?:全院|全部(?:疗程|療程|服务|服務|价目|價目)|所有(?:疗程|療程|服务|服務|项目|項目)|\b(?:all\s+(?:treatments?|services?)|whole\s+clinic|price\s+list)\b)/iu;
const JOINT_INTENT = /(?:3\s*d\s*[+＋]\s*9\s*d|9\s*d\s*[+＋]\s*3\s*d|组合|組合|搭配|一起\s*做|一齐\s*做|一齊\s*做|同时\s*做|同時\s*做|加起来|加起來|打包价|打包價|\b(?:combo|bundle|combined|together|gabungan|sekaligus)\b)/iu;

function named3D9D(text) {
  const value = String(text || "");
  return {
    face: /(^|[^a-z0-9])3\s*d(?![a-z0-9])/iu.test(value),
    firming: /(^|[^a-z0-9])9\s*d(?![a-z0-9])/iu.test(value),
  };
}

function safeRecentSession(session, customerText, now) {
  if (!Array.isArray(session) || !session.length || !Number.isFinite(now)) return null;
  const last = session.at(-1);
  if (last?.role !== "user" ||
      String(last.content || "").trim() !== String(customerText || "").trim()) return null;
  const recent = [];
  for (const turn of session) {
    const at = turn?.pricingCreatedAtMs;
    if (!Number.isFinite(at) || at < now - MAX_CONTEXT_MS || at > now + 60_000 ||
        isVerifiedStaffTurn(turn)) return null;
    if (turn.role === "user" &&
        (hasClinicalMediaRisk(String(turn.content || "")) ||
         REJECT.test(String(turn.content || "")))) return null;
    recent.push(turn);
  }
  return recent;
}

function verifiedComboOffer(promotions, now, current, session) {
  const matches = getActivePromotions(promotions, new Date(now))
    .filter(item => item?.linkedService === COMBO_SERVICE && item?.sendOnPriceQuery === true);
  if (matches.length !== 1) return null;
  const prices = verifiedPricesForService(
    COMBO_SERVICE, promotions, current, session, { allowTextOnlyOffers: true }
  );
  if (prices?.length !== 1 || !/^RM[1-9]\d{0,5}$/u.test(String(prices[0]?.price || ""))) return null;
  const offer = matches[0];
  const text = String(offer.followUpMessage || "");
  const complimentaryMeridianHour = /(?:免费送|免費送|赠送|贈送).{0,15}(?:1\s*小时|1\s*小時|一小时|一小時).{0,20}(?:经络|經絡)/u.test(text);
  return { treatment: COMBO_SERVICE, price: prices[0].price, complimentaryMeridianHour };
}

// '3D 和 9D 分别多少钱' remains two individual prices. Suggest the combo
// only AFTER the current verified individual quote, never as its replacement.
// An explicit joint-package price question, by contrast, gets the verified
// combo price alone and never silently adds two standalone prices.
function resolveNeutroComboOfferReply({
  customerText, session = [], promotions = [], services = [], serviceAliases = [],
  language = "zh", verifiedIndividualQuote = false, now = Date.now(),
} = {}) {
  const current = String(customerText || "").trim();
  if (!current || !hasExplicitPriceRequest(current) || ADMIN_PRICE.test(current) ||
      BROAD.test(current) || NO_COMBO.test(current) || REJECT.test(current) ||
      hasClinicalMediaRisk(current)) return null;
  const turns = safeRecentSession(session, current, now);
  if (!turns) return null;

  const currentNames = named3D9D(current);
  const allowed = new Set([...INDIVIDUAL_SERVICES, COMBO_SERVICE]);
  const otherServices = findServicesInText(
    current, serviceCandidates(services, serviceAliases)
  ).filter(name => !allowed.has(name));
  if (otherServices.length) return null;
  const explicitlyJoint = currentNames.face && currentNames.firming &&
    JOINT_INTENT.test(current);
  if (!explicitlyJoint && !verifiedIndividualQuote) return null;

  const offer = verifiedComboOffer(promotions, now, current, turns);
  if (!offer) return null;
  const locale = String(language || "zh").toLowerCase();
  const gift = offer.complimentaryMeridianHour
    ? locale.startsWith("ms") ? " termasuk urutan meridian percuma selama 1 jam"
      : locale.startsWith("en") ? ", with a complimentary one-hour meridian massage"
        : "，另送 1 小时经络按摩"
    : "";

  if (explicitlyJoint) {
    const reply = locale.startsWith("ms")
      ? `Harga promosi pakej 3D + 9D sekarang ialah ${offer.price}${gift} 😊 Kesesuaian rawatan bersama akan dinilai oleh pengamal dahulu.`
      : locale.startsWith("en")
        ? `The current 3D + 9D combination offer is ${offer.price}${gift} 😊 Our practitioner will assess whether both treatments are suitable.`
        : `3D + 9D 组合目前的体验优惠是 ${offer.price}${gift} 😊 是否适合一起安排，还是需要先让中医师评估哦。`;
    return { ...offer, mode: "direct", reply };
  }

  const userTurns = turns.filter(turn => turn.role === "user");
  const named = userTurns.map(turn => named3D9D(turn.content));
  if (!(named.some(item => item.face) && named.some(item => item.firming)) ||
      (!currentNames.face && !currentNames.firming)) return null;
  // Never repeat an offer already made in this recent conversation.
  if (turns.some(turn => turn.role === "assistant" &&
      String(turn.content || "").includes(offer.price) &&
      (JOINT_INTENT.test(String(turn.content || "")) ||
       (/3\s*d/iu.test(turn.content) && /9\s*d/iu.test(turn.content))))) return null;
  const reply = locale.startsWith("ms")
    ? `Jika anda berminat dengan kedua-dua rawatan, kami juga ada pakej 3D + 9D pada ${offer.price}${gift} 😊 Pengamal akan semak kesesuaian dahulu.`
    : locale.startsWith("en")
      ? `If you're interested in both, there's also a 3D + 9D combination offer for ${offer.price}${gift} 😊 Our practitioner can assess suitability first.`
      : `如果你两项都想体验，我们目前也有 3D + 9D 组合优惠 ${offer.price}${gift} 😊 中医师会先评估是否适合一起安排。`;
  return { ...offer, mode: "suggestion", reply };
}

module.exports = { resolveNeutroComboOfferReply };
