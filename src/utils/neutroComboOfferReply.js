"use strict";

// Offer Neutro's separately configured 3D + 9D package without conflating
// two individual First Trial prices with the price of one combined package.
// This only formats verified text. It does not authorize promotional media.
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { getActivePromotions, getPricePromotionBundle } = require("./activePromotion");
const { verifiedPricesForService } = require("./verifiedPriceReply");
const {hasMyrAmount}=require("./myrAmountClaims");
const {comboDraftMatches}=require("./verifiedSpecialReply");
const { isVerifiedStaffTurn } = require("./priceFollowUpContext");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");

const COMBO_SERVICE = "3D + 9D 组合";
const INDIVIDUAL_SERVICES = new Set(["3D 小颜术", "9D 逆龄抗衰"]);
const MAX_CONTEXT_MS = 3 * 60 * 60 * 1000;
const REJECT = /(?:退订|退訂|不要再发|不要再發|停止发|停止發|不想(?:做|了解)|不需要(?:治疗|治療|护理|護理)|\b(?:stop\s+(?:messag|promot)|opt[ -]?out|unsubscribe|not\s+interested)\b)/iu;
const NO_COMBO = /(?:不要|不想要?|不需要|不选|不選|不用|不是)\s*(?:3\s*d\s*[+＋]\s*9\s*d\s*)?(?:组合|組合|搭配|combo|bundle)|\b(?:no|not|without|bukan|tak\s+nak)\s+(?:the\s+)?(?:combo|bundle|pakej)\b/iu;
const NO_INDIVIDUAL = /(?:不要|不想(?:要|做|了解)?|不考虑|不考慮|不用|不是|排除)\s*(?:做|了解)?\s*(?:3\s*d|9\s*d)|(?:3\s*d|9\s*d)\s*(?:不要|不做|不用|不想(?:要|做)?|不考虑|不考慮)|(?:只想|只要|只做|仅想|僅想)\s*(?:要|做|了解)?\s*(?:3\s*d|9\s*d)|\b(?:not|without|no|only|just)\s+(?:the\s+)?(?:3\s*d|9\s*d)\b/iu;
const ADMIN_PRICE = /(?:押金|订金|訂金|定金|咨询费|諮詢費|挂号|掛號|评估费|評估費|booking\s+fee|deposit|assessment\s+fee|consultation\s+fee)/iu;
const BROAD = /(?:全院|全部(?:疗程|療程|服务|服務|价目|價目)|所有(?:疗程|療程|服务|服務|项目|項目)|\b(?:all\s+(?:treatments?|services?)|whole\s+clinic|price\s+list)\b)/iu;
const SEPARATE_INTENT = /(?:分开|分開|分别|分別|各自|单独|單獨|\b(?:separately|individually|each|asing[- ]asing)\b)/iu;
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
  if(prices[0].afterVoucher || prices[0].sessionsIncluded>1)return null;
  const offer = matches[0];
  const text = String(offer.followUpMessage || "");
  const complimentaryMeridianHour = /(?:免费送|免費送|赠送|贈送).{0,15}(?:1\s*小时|1\s*小時|一小时|一小時).{0,20}(?:经络|經絡)/u.test(text);
  return { treatment: COMBO_SERVICE, price: prices[0].price, complimentaryMeridianHour, afterVoucher:false };
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
      BROAD.test(current) || NO_COMBO.test(current) || NO_INDIVIDUAL.test(current) ||
      REJECT.test(current) ||
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
    JOINT_INTENT.test(current) && !SEPARATE_INTENT.test(current);
  const jointlyNamed = currentNames.face && currentNames.firming;
  const ambiguousBothPrices = jointlyNamed && !explicitlyJoint &&
    !SEPARATE_INTENT.test(current);
  if (!explicitlyJoint && !verifiedIndividualQuote && !ambiguousBothPrices) return null;

  const offer = verifiedComboOffer(promotions, now, current, turns);
  if (!offer) return null;
  const locale = String(language || "zh").toLowerCase();
  const gift = offer.complimentaryMeridianHour
    ? locale.startsWith("ms") ? " termasuk urutan meridian percuma selama 1 jam"
      : locale.startsWith("en") ? ", with a complimentary one-hour meridian massage"
        : "，另送 1 小时经络按摩"
    : "";

  // A customer saying "3D 和 9D 多少钱" asked for both, but did NOT
  // explicitly choose separate pricing or one combined treatment. Answer with
  // both independently verified individual prices AND the distinct combo,
  // without treating the customer's ambiguity as permission to send images.
  if (ambiguousBothPrices) {
    const standalone = ["3D 小颜术", "9D 逆龄抗衰"].map(name => {
      const entries = verifiedPricesForService(name, promotions, current, turns);
      return entries?.length === 1 ? { name, price:entries[0].price } : null;
    });
    if (standalone.some(item => !item || !/^RM[1-9]\d{0,5}$/u.test(item.price))) return null;
    const reply = locale.startsWith("ms")
      ? `Harga First Trial 3D ialah ${standalone[0].price}, dan 9D ialah ${standalone[1].price} secara berasingan. Jika berminat dengan kedua-duanya, pakej 3D + 9D kini ${offer.price}${gift} 😊 Pengamal akan semak kesesuaian dahulu.`
      : locale.startsWith("en")
        ? `The separate 3D and 9D First Trial offers are ${standalone[0].price} and ${standalone[1].price}. If you'd like both, the 3D + 9D combination offer is ${offer.price}${gift} 😊 Our practitioner can assess suitability first.`
        : `3D 和 9D 分开体验的 First Trial 价格各是 ${standalone[0].price} 和 ${standalone[1].price}。如果两个都想体验，目前还有 3D + 9D 组合优惠 ${offer.price}${gift} 😊 中医师会先评估是否适合一起安排。`;
    return { ...offer, mode:"direct", individualPrices:standalone, reply };
  }

  if (explicitlyJoint) {
    const reply = locale.startsWith("ms")
      ? `Harga promosi pakej 3D + 9D sekarang ialah ${offer.price}${gift} 😊 Kesesuaian rawatan bersama akan dinilai oleh pengamal dahulu.`
      : locale.startsWith("en")
        ? `The current 3D + 9D combination offer is ${offer.price}${gift} 😊 Our practitioner will assess whether both treatments are suitable.`
        : `3D + 9D 组合目前的体验优惠是 ${offer.price}${gift} 😊 是否适合一起安排，还是需要先让中医师评估哦。`;
    return { ...offer, mode: "direct", reply };
  }

  const userTurns = turns.filter(turn => turn.role === "user");
  // Do not re-sell a combo that this customer already declined. An explicit
  // new joint-package request is handled separately above.
  if (userTurns.some(turn => NO_COMBO.test(String(turn.content || "")))) return null;
  const named = userTurns.map(turn => named3D9D(turn.content));
  if (!(named.some(item => item.face) && named.some(item => item.firming)) ||
      (!currentNames.face && !currentNames.firming)) return null;
  // Never repeat an offer already made in this recent conversation.
  if (turns.some(turn => turn.role === "assistant" &&
      hasMyrAmount(turn.content,Number(offer.price.slice(2))) &&
      (JOINT_INTENT.test(String(turn.content || "")) ||
       (/3\s*d/iu.test(turn.content) && /9\s*d/iu.test(turn.content))))) return null;
  const reply = locale.startsWith("ms")
    ? `Jika anda berminat dengan kedua-dua rawatan, kami juga ada pakej 3D + 9D pada ${offer.price}${gift} 😊 Pengamal akan semak kesesuaian dahulu.`
    : locale.startsWith("en")
      ? `If you're interested in both, there's also a 3D + 9D combination offer for ${offer.price}${gift} 😊 Our practitioner can assess suitability first.`
      : `如果你两项都想体验，我们目前也有 3D + 9D 组合优惠 ${offer.price}${gift} 😊 中医师会先评估是否适合一起安排。`;
  return { ...offer, mode: "suggestion", reply };
}

// The customer may refer to "doing these together" after staff has shown 9D
// and the same conversation already compared 3D and 9D. Only answer from an
// independently verified CURRENT combo offer. No combo duration or image can
// be inferred from the two standalone services.
function resolveContextualNeutroComboQuestion({
 customerText,history=[],services=[],serviceAliases=[],promotions=[],
 language="zh",now=Date.now(),
}={}){
 const current=String(customerText||"").trim();
 if(!current||current.length>150||!hasExplicitPriceRequest(current)||
   !/(?:一起\s*做|一齐\s*做|一齊\s*做|同时\s*做|同時\s*做|两个\s*一起|兩個\s*一起|\b(?:together|combined|combo)\b)/iu.test(current)||
   !/(?:多久|多长|多長|小时|小時|要多长时间|要多長時間|\b(?:how\s+long|duration|hours?)\b)/iu.test(current)||
   REJECT.test(current)||NO_COMBO.test(current)||hasClinicalMediaRisk(current)||
   !Array.isArray(history)||history.length<3)return null;
 const last=history.at(-1);
 if(last?.role!=="user"||String(last.content||"").trim()!==current ||
   !Number.isFinite(last.pricingCreatedAtMs) ||
   Math.abs(last.pricingCreatedAtMs-now)>5*60_000)return null;
 const named=findServicesInText(current,serviceCandidates(services,serviceAliases));
 if(named.some(n=>!INDIVIDUAL_SERVICES.has(n)&&n!==COMBO_SERVICE))return null;
 const prior=history.slice(0,-1).filter(t=>t?.role==="assistant"&&
   Number.isFinite(t.pricingCreatedAtMs)&&
   t.pricingCreatedAtMs<=now&&t.pricingCreatedAtMs>=now-24*3600_000);
 const compared=prior.some(t=>/3\s*d/iu.test(String(t.content||""))&&
   /9\s*d/iu.test(String(t.content||"")));
 const current9d=prior.some(t=>t.pricingCreatedAtMs>=now-2*3600_000&&
   /9\s*d/iu.test(String(t.content||"")));
 if(!compared||!current9d)return null;
 const offer=verifiedComboOffer(promotions,now,current,history);
 if(!offer)return null;
 const isMS=/^ms/iu.test(language),isEN=/^en/iu.test(language);
 const reply=isMS
  ? "Pakej 3D + 9D yang disahkan sekarang ialah "+offer.price+
    " 😊 Tempoh keseluruhan gabungan perlu disahkan dengan pihak pusat dahulu. Pengamal akan menilai sama ada kedua-dua rawatan sesuai dilakukan bersama."
  : isEN
    ? "The verified 3D + 9D combination offer is "+offer.price+
      " 😊 The clinic needs to confirm the total combined session duration. Our practitioner will first assess whether both treatments are suitable together."
    : "3D + 9D 组合目前核实的体验优惠是 "+offer.price+
      " 😊 两项一起做的实际总时长还需要请门店确认，不能直接把两项单独护理时间相加。中医师也会先评估是否适合一起安排。";
 return {...offer,mode:"contextual",reply};
}

// Media is authorized independently of the model and the reply formatter.
// The existing promotion selector still applies staff, clinical, billing,
// delivery receipt, duplicate URL and 24-hour cooldown safeguards.
function resolveNeutroComboMediaPricingDecision({
  comboOfferDecision, promotions = [], customerText = "", session = null,
  reply = "", now = Date.now(),
} = {}) {
  if (!comboOfferDecision ||
      !["direct", "suggestion"].includes(comboOfferDecision.mode) ||
      comboOfferDecision.treatment !== COMBO_SERVICE ||
      !hasMyrAmount(reply,Number(comboOfferDecision.price.slice(2)))) return null;
  // An approved combo amount elsewhere in the text is not proof it was
  // quoted for this combination. Direct replies must still match the facts
  // approved by the combo resolver. Suggestion mode retains its exact appended
  // block, which is independently checked below.
  if(comboOfferDecision.mode==="direct" && !comboDraftMatches(reply,comboOfferDecision))return null;
  if(comboOfferDecision.mode==="suggestion") {
    const lastBlock=String(reply||"").split(/\n\s*\n/u).at(-1);
    if(!comboDraftMatches(lastBlock,comboOfferDecision))return null;
  }

  const bundle = getPricePromotionBundle(
    promotions, COMBO_SERVICE, null, new Date(now)
  );
  // A single approved RM688 graphic, never an unrelated package or a
  // multi-image blast. A missing/pending promotion safely remains text-only.
  if (bundle?.packages?.length !== 1) return null;
  const prices = verifiedPricesForService(
    COMBO_SERVICE, promotions, customerText, session,
    { allowTextOnlyOffers: true }
  );
  if (prices?.length !== 1 ||
      prices[0].name !== bundle.packages[0].name ||
      prices[0].price !== comboOfferDecision.price) return null;
  return {
    source: "verified_neutro_combo_image",
    treatment: COMBO_SERVICE,
    type: "price",
    prices,
  };
}

module.exports = {
  resolveNeutroComboOfferReply,
  resolveContextualNeutroComboQuestion,
  resolveNeutroComboMediaPricingDecision,
};
