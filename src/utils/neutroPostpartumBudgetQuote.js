"use strict";

// A customer who came for pulse-wave care may discuss postpartum changes and
// uncertainty about pelvic care before asking what to budget. Neither the
// original ad nor the bot's suggestions selects a treatment. Quote ONLY the
// two independently verified active alternatives as text, never promo media.
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { pricingMessageText, isVerifiedStaffTurn, isRecentPricingThread } =
  require("./priceFollowUpContext");
const { getActivePromotions } = require("./activePromotion");
const { verifiedPricesForService } = require("./verifiedPriceReply");

const PULSE = "脉冲波调理";
const PELVIC = "骨盆调理";
const DISALLOWED = /(?:订金|訂金|定金|押金|挂号费|掛號費|咨询费|諮詢費|评估费|評估費|面诊费|面診費|退款|取消|改聊|改做|换个|換個|退订|退訂|\b(?:deposit|booking fee|consultation fee|assessment fee|refund|cancel|stop|unsubscribe)\b)/iu;
const UNRELATED = /(?:\b(?:3\s*d|9\s*d)\b|小颜|小顏|逆龄|逆齡|胸部|乳腺|肩颈|肩頸|筋膜)/iu;
const REPEAT = /(?:第二次|后续|後續|续做|續做|\b(?:second|repeat|subsequent)\s+(?:session|treatment)\b)/iu;
const PRICE_TERMS = /(?:收[费費]|费[用]|費用|价[格钱錢]|價錢|\b(?:price|cost|fee|harga)\b)/iu;
const BUDGET_TERMS = /(?:预算|預算|\bbudget\b)/iu;
const REQUEST = /(?:可以|能|想|请|請|麻烦|麻煩).{0,45}(?:知道|了解|看看|问|問|告诉|告訴)/iu;
const PELVIC_UNCERTAIN = /(?:骨盆|盆骨)/u;
const UNCERTAIN = /(?:不确定|不確定|不清楚|不知道|是不是|是否需要|需不需要|unsure|not sure)/iu;
const POSTPARTUM = /(?:产后|產後|生完|生过|生過|postpartum)/iu;
const MENU_BOTH = /(?:骨盆调理.{0,50}脉冲波|脉冲波.{0,50}骨盆调理)/u;

function resolveNeutroPostpartumBudgetQuote({
  customerText, session = [], services = [], serviceAliases = [],
  promotions = [], language = "zh", now = Date.now(),
} = {}) {
  const current = String(customerText || "").trim();
  // A budget *statement*, a price objection, a general catalogue request,
  // or a treatment/assessment fee question never opens this exception.
  if (!current || current.length > 180 || !Number.isFinite(now) ||
      !hasExplicitPriceRequest(current) || !PRICE_TERMS.test(current) ||
      !BUDGET_TERMS.test(current) || !REQUEST.test(current) ||
      DISALLOWED.test(current) || UNRELATED.test(current) ||
      REPEAT.test(current) || hasClinicalMediaRisk(current) ||
      /(?:全部|所有|价目表|價目表|一起做|总共|總共|\b(?:all treatments|price list|combined total)\b)/iu.test(current)) return null;

  const turns = Array.isArray(session) ? session : [];
  if (turns.length < 6 || turns.length > 24 ||
      turns.at(-1)?.role !== "user" ||
      pricingMessageText(turns.at(-1)).trim() !== current ||
      !isRecentPricingThread(turns, 0, now) ||
      turns.some(turn => isVerifiedStaffTurn(turn) ||
        (turn?.role === "user" && hasClinicalMediaRisk(pricingMessageText(turn))))) return null;

  // The first verified customer request is for pulse-wave care. Later a
  // CUSTOMER expressed uncertainty about pelvic adjustment, and the bot
  // explicitly presented both as alternatives. "产后" alone is a symptom
  // description here, never proof of the separate paid 产后调理 service.
  const before = turns.slice(0, -1);
  const firstUser = before.find(turn => turn?.role === "user");
  const firstText = pricingMessageText(firstUser);
  if (!firstUser || !/(?:有兴趣|有興趣|想了解|想知道|interested)/iu.test(firstText) ||
      safeServiceFromCustomer(firstText, services, serviceAliases)?.name !== PULSE)
    return null;

  const concernIndex = before.findIndex((turn, index) =>
    index > before.indexOf(firstUser) && turn?.role === "user" &&
    PELVIC_UNCERTAIN.test(pricingMessageText(turn)) &&
    UNCERTAIN.test(pricingMessageText(turn)) &&
    POSTPARTUM.test(pricingMessageText(turn)));
  if (concernIndex < 0) return null;

  const candidates = serviceCandidates(services, serviceAliases);
  for (const turn of before) {
    if (turn?.role !== "user") continue;
    const value = pricingMessageText(turn);
    if (DISALLOWED.test(value) || UNRELATED.test(value) ||
        /(?:产后|產後)(?:调理|調理|护理|護理|疗程|療程)/u.test(value) ||
        findServicesInText(value, candidates).some(name =>
          ![PULSE, PELVIC, "产后调理", "1对1体态评估"].includes(name))) return null;
  }

  const menuIndex = before.findIndex((turn, index) =>
    index > concernIndex && turn?.role === "assistant" &&
    !isVerifiedStaffTurn(turn) &&
    MENU_BOTH.test(pricingMessageText(turn)) &&
    /(?:还是|還是|或者|或|选择|選擇|\bor\b)/iu.test(pricingMessageText(turn)) &&
    !PRICE_TERMS.test(pricingMessageText(turn)) &&
    !/\b(?:RM|MYR)\s*\d+/iu.test(pricingMessageText(turn)));
  if (menuIndex < 0) return null;
  // A later customer choice, competing treatment, or staff quote ends the
  // uncertainty. Do not quote both from an old bot menu.
  const remainder = before.slice(menuIndex + 1);
  if (remainder.some(turn => turn.role === "user" &&
      (PELVIC_UNCERTAIN.test(pricingMessageText(turn)) ||
       /(?:脉冲|脈衝|\bpulse\b|想做|要做|决定|決定|选|選)/iu.test(pricingMessageText(turn)))))
    return null;

  const active = getActivePromotions(promotions, new Date(now));
  const selected = [PULSE, PELVIC].map(treatment => {
    const campaigns = active.filter(p =>
      p.linkedService === treatment && p.sendOnPriceQuery === true);
    if (campaigns.length !== 1) return null;
    const prices = verifiedPricesForService(
      treatment, promotions, "", turns, { allowTextOnlyOffers: true });
    if (!prices?.length || prices.some(p => !/^RM[1-9]\d{0,5}$/u.test(p.price)))
      return null;
    return { treatment, packages: prices };
  });
  if (selected.some(x => !x)) return null;
  const pulse = selected[0].packages;
  const pelvis = selected[1].packages;
  if (pulse.length !== 1 || pelvis.length !== 2 ||
      !pelvis.some(p => p.name === "Package A") ||
      !pelvis.some(p => p.name === "Package B")) return null;
  const packageA = pelvis.find(p => p.name === "Package A");
  const packageB = pelvis.find(p => p.name === "Package B");

  const locale = String(language || "").toLowerCase();
  const lines = [
    PULSE + ": " + pulse[0].price,
    PELVIC + " Package A: " + packageA.price,
    PELVIC + " Package B: " + packageB.price,
  ];
  const reply = locale.startsWith("en")
    ? "Of course 😊 To help you plan your budget, these are the current separate offers:\n" +
      lines.map(s => "• " + s).join("\n") +
      "\n\nThey are separate treatment options, not a combined price. Since you are unsure whether pelvic care is needed, our practitioner can assess your situation before recommending a treatment or number of sessions."
    : locale.startsWith("ms")
      ? "Boleh 😊 Untuk rujukan bajet, ini harga tawaran semasa bagi pilihan berasingan:\n" +
        lines.map(s => "• " + s).join("\n") +
        "\n\nIni bukan harga gabungan. Jika anda belum pasti sama ada perlu rawatan pelvis, pengamal kami boleh menilai keadaan anda dahulu sebelum mencadangkan rawatan atau bilangan sesi."
      : "可以的～先给你参考目前的护理预算哦 😊\n" +
        lines.map(s => "• " + s).join("\n") +
        "\n\n以上是不同护理及配套的优惠参考价，不是组合收费。你还不确定是否需要骨盆调理的话，可以先让中医师评估，再决定哪项适合自己及需要做几次哦 💕";

  return {
    source: "verified_postpartum_budget_options",
    prices: [
      { treatment: PULSE, amount: pulse[0].price },
      { treatment: PELVIC, amount: packageA.price + " / " + packageB.price },
    ],
    reply,
  };
}

module.exports = { resolveNeutroPostpartumBudgetQuote };
