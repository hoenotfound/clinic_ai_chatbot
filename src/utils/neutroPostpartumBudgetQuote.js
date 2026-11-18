"use strict";

// Text-only recovery for verified, customer-led conversations about Pulse Wave
// and pelvic care. The initial customer choice and an assistant-presented
// two-option comparison are required; ads, CRM labels and model guesses alone
// cannot authorize a quote. Optional promotional graphics stay disabled.
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { serviceCandidates, findServicesInText } = require("./conversationPromptContext");
const { pricingMessageText, isVerifiedStaffTurn, isRecentPricingThread } =
  require("./priceFollowUpContext");
const { getActivePromotions, promotionPackages } = require("./activePromotion");
const { verifiedPricesForService } = require("./verifiedPriceReply");

const PULSE = "脉冲波调理";
const PELVIC = "骨盆调理";
const OPTIONS = [PULSE, PELVIC];
const ADMIN_OR_STOP = /(?:订金|訂金|定金|押金|挂号费|掛號費|咨询费|諮詢費|评估费|評估費|面诊费|面診費|退款|取消预约|取消預約|退订|退訂|不要报价|不想看价格|别发价格|\b(?:deposit|booking fee|consultation fee|assessment fee|refund|cancel|stop|unsubscribe)\b)/iu;
const UNRELATED = /(?:\b(?:3\s*d|9\s*d)\b|小颜|小顏|逆龄|逆齡|胸部|乳腺|肩颈|肩頸|筋膜)/iu;
const REPEAT = /(?:第二次|后续|後續|续做|續做|\b(?:second|repeat|subsequent)\s+(?:session|treatment)\b)/iu;
const PRICE_WORD = /(?:多少[钱錢]|几多钱|幾多錢|收[费費]|费[用]|費用|价[格钱錢位]|價錢|\b(?:price|pricing|cost|fees?|harga|how\s+much)\b)/iu;
const REQUEST = /(?:^(?:请问|請問)?\s*(?:价钱|價錢|价格|價格|价位|價位|收费|收費|费用|費用)(?:如何|多少|呢)?[?？!！。.]?\s*$|[?？]|(?:可以|能|想|请|請|麻烦|麻煩|告诉|告訴|给我|給我).{0,55}(?:知道|了解|看看|问|問|告诉|告訴|参考|參考|收费|收費|价格|價錢)|\b(?:how\s+much|what(?:'s| is)|can\s+i|could\s+you|please|berapa)\b)/iu;
const UNWANTED = /(?:不(?:想|要|需要|考虑|考慮)(?:做|了解|看)?|不做|别|別|不要这个|不要這個|\b(?:don't\s+want|not\s+interested|no\s+pelvic|no\s+pulse|without)\b)/iu;
const TOPIC_SWITCH = /(?:改聊|换话题|換話題|换个|換個|其他疗程|其它疗程|其他療程|另一个疗程|另一個療程|\b(?:switch\s+treatment|instead\s+of|another\s+treatment)\b)/iu;
const MENU_BOTH = /(?:骨盆调理.{0,75}(?:脉冲波|脈衝波)|(?:脉冲波|脈衝波).{0,75}骨盆调理)/iu;
const COMPARISON = /(?:还是|還是|或者|选择|選擇|从|從|分别|分別|各自|不同|\b(?:or|alternatively|options?|choices?|versus|vs)\b)/iu;
const VOUCHER = /(?:优惠券|優惠券|抵用券|\b(?:voucher|coupon|baucar)\b)/iu;
const VOUCHER_100 = /(?:RM\s*100.{0,32}(?:优惠券|優惠券|抵用券|voucher|coupon|baucar)|(?:优惠券|優惠券|抵用券|voucher|coupon|baucar).{0,32}RM\s*100)/iu;

function customerSelection(text, services, aliases) {
  const selected = safeServiceFromCustomer(text, services, aliases);
  return OPTIONS.includes(selected?.name) ? selected.name : null;
}

// A refusal is not evidence of interest. If one treatment is explicitly
// rejected and another directly requested, only the positive choice remains.
// When neither is positively requested, fail closed, never quote both.
function explicitlyRejectedService(text) {
  const source = String(text || "");
  const declined = OPTIONS.filter(name => {
    const aliases = name === PULSE
      ? "(?:脉冲波|脈衝波|脉冲|脈衝|黄金脉冲|黃金脈衝|pulse(?: wave)?)"
      : "(?:骨盆|盆骨|pelvic|pelvis)";
    return new RegExp(
      "(?:不(?:想|要|需要|考虑|考慮)(?:做|了解|看)?|不做|别|別|不要这个|不要這個|not\\s+interested\\s+in|don't\\s+want|do\\s+not\\s+want|without|no)\\s*.{0,12}" + aliases,
      "iu"
    ).test(source);
  });
  return declined;
}

function verifiedOptions(treatment, promotions, turns, now, customerText = "") {
  const active = getActivePromotions(promotions, new Date(now))
    .filter(p => p.linkedService === treatment && p.sendOnPriceQuery === true);
  if (active.length !== 1) return null;
  const campaign = active[0];
  const options = promotionPackages(campaign);
  const priced = verifiedPricesForService(
    treatment, promotions, customerText, turns, { allowTextOnlyOffers: true }
  );
  if (!priced?.length || !options.length || priced.length > 4 ||
      priced.some(x => !/^RM[1-9]\d{0,5}$/u.test(x.price))) return null;
  const resolved = priced.map(item => {
    const option = options.find(o => o.name === item.name);
    if (!option) return null;
    const captions = [
      option.caption, option.followUpMessage,
      ...Object.values(option.mediaTranslations || {})
        .map(x => typeof x === "string" ? x : x?.caption),
      ...Object.values(option.followUpTranslations || {})
        .map(x => typeof x === "string" ? x : x?.message),
    ].filter(Boolean).join("\n");
    const hasVoucher = VOUCHER.test(captions);
    // The current local clinic config uses RM100 coupons for BOTH pelvic
    // packages. Do not silently quote those conditional offers as guaranteed.
    // Every caption language with a voucher must agree on the RM100 amount.
    const normal = option.pricing?.normal, offer = option.pricing?.offer;
    if (hasVoucher && (!VOUCHER_100.test(captions) ||
        !Number.isSafeInteger(normal) || !Number.isSafeInteger(offer) ||
        normal - offer !== 100)) return null;
    const needsBooking = /(?:预约专享|預約專享|\b(?:exclusive\s+for\s+(?:appointments?|bookings?)|tempahan)\b)/iu
      .test(captions);
    return {
      name: item.name, price: item.price, voucher: hasVoucher,
      needsBooking,
    };
  });
  return resolved.every(Boolean) ? { campaign, options: resolved } : null;
}

function lineFor(treatment, option, language) {
  const locale = String(language || "").toLowerCase();
  const name = treatment + (treatment === PELVIC ? " " + option.name : "");
  const suffix = !option.voucher ? "" : locale.startsWith("ms")
    ? " (selepas baucar RM100, tertakluk pada syarat dan ketersediaan)"
    : locale.startsWith("en")
      ? " (after RM100 voucher, subject to eligibility and availability)"
      : "（使用 RM100 优惠券后，须符合条件及确认名额）";
  const booking = !option.needsBooking ? "" : locale.startsWith("ms")
    ? " (untuk tempahan)" : locale.startsWith("en")
      ? " (appointment offer)" : "（预约专享）";
  return "• " + name + "：" + option.price + suffix + booking;
}

function resolveNeutroPostpartumBudgetQuote({
  customerText, session = [], services = [], serviceAliases = [],
  promotions = [], language = "zh", now = Date.now(),
} = {}) {
  const current = String(customerText || "").trim();
  // Customer's present question must ask for a treatment amount, not merely
  // state a budget, complain about a price or ask the assessment fee.
  if (!current || current.length > 200 || !Number.isFinite(now) ||
      !hasExplicitPriceRequest(current) || !PRICE_WORD.test(current) ||
      !REQUEST.test(current) || ADMIN_OR_STOP.test(current) ||
      UNRELATED.test(current) || REPEAT.test(current) ||
      TOPIC_SWITCH.test(current) || hasClinicalMediaRisk(current) ||
      /(?:全院|全部疗程|所有疗程|所有服務|价目表|價目表|一起做|总共|總共|\b(?:all\s+treatments|price\s+list|combined\s+total)\b)/iu.test(current))
    return null;

  const turns = Array.isArray(session) ? session : [];
  if (turns.length < 4 || turns.length > 24 ||
      turns.at(-1)?.role !== "user" ||
      pricingMessageText(turns.at(-1)).trim() !== current ||
      !isRecentPricingThread(turns, 0, now) ||
      turns.some(turn => isVerifiedStaffTurn(turn) ||
        (turn?.role === "user" && hasClinicalMediaRisk(pricingMessageText(turn)))))
    return null;

  const before = turns.slice(0, -1);
  const candidates = serviceCandidates(services, serviceAliases);
  const firstCustomer = before.findIndex(t => t?.role === "user" &&
    customerSelection(pricingMessageText(t), services, serviceAliases));
  if (firstCustomer < 0) return null;
  const initialChoice = customerSelection(
    pricingMessageText(before[firstCustomer]), services, serviceAliases
  );
  if (!/(?:有兴趣|有興趣|想了解|想知道|想问|想問|\b(?:interested|enquir|inquir|learn)\b)/iu
    .test(pricingMessageText(before[firstCustomer]))) return null;

  // The bot must acknowledge the customer's actual interest, then explicitly
  // offer the two services as separate alternatives after that request.
  const acknowledged = before.slice(firstCustomer + 1).some(t =>
    t.role === "assistant" && !isVerifiedStaffTurn(t) &&
    findServicesInText(pricingMessageText(t), candidates).includes(initialChoice));
  if (!acknowledged) return null;
  let menuIndex = -1;
  for (let i = firstCustomer + 1; i < before.length; i++) {
    const t = before[i], value = pricingMessageText(t);
    if (t.role !== "assistant" || !MENU_BOTH.test(value) ||
        !COMPARISON.test(value) || isVerifiedStaffTurn(t)) continue;
    const mentioned = [...new Set(findServicesInText(value, candidates))]
      .filter(name => name !== "1对1体态评估" && name !== "产后调理");
    if (!mentioned.includes(PULSE) || !mentioned.includes(PELVIC) ||
        mentioned.some(name => !OPTIONS.includes(name))) continue;
    menuIndex = i;
  }
  if (menuIndex < 0) return null;

  // A later customer treatment change/refusal overrides the bot's earlier
  // menu. An unrecognized refusal never permits either quote.
  const currentRejected = explicitlyRejectedService(current);
  const currentChoice = customerSelection(current, services, serviceAliases);
  if (currentRejected.length && (!currentChoice ||
      currentRejected.includes(currentChoice))) return null;

  let latestPriorChoice = null;
  for (const t of before.slice(menuIndex + 1)) {
    if (t.role !== "user") continue;
    const value = pricingMessageText(t);
    if (TOPIC_SWITCH.test(value) || ADMIN_OR_STOP.test(value) || UNRELATED.test(value) ||
        /(?:产后|產後)(?:调理|調理|护理|護理|疗程|療程)/u.test(value) ||
        findServicesInText(value, candidates).some(name =>
          ![...OPTIONS, "产后调理", "1对1体态评估"].includes(name))) return null;
    const declined = explicitlyRejectedService(value);
    const selected = customerSelection(value, services, serviceAliases);
    if (declined.length && (!selected || declined.includes(selected))) return null;
    if (selected) latestPriorChoice = selected;
    else if (declined.length) return null;
    else if (/(?:我想做|我要做|决定|決定|我选择|我選擇|只想做|只要做)/iu.test(value)) return null;
  }
  // Do not let the bot reintroduce a refused treatment.
  const choice = currentChoice || latestPriorChoice;
  if (choice && currentRejected.includes(choice)) return null;
  const selected = choice ? [choice] : OPTIONS;
  // Never quote a clinic-wide catalogue or additional unspecified offerings.
  if (selected.length === 2 && currentRejected.length) return null;
  const directNames = [...new Set(findServicesInText(current, candidates))]
    .filter(name => name !== "产后调理");
  if (!choice && directNames.length) return null;

  const quotes = selected.map(treatment =>
    ({ treatment, verified: verifiedOptions(
      treatment, promotions, turns, now,
      choice === treatment ? current : ""
    ) }));
  if (quotes.some(x => !x.verified)) return null;

  const locale = String(language || "").toLowerCase();
  const lines = quotes.flatMap(({ treatment, verified }) =>
    verified.options.map(option => lineFor(treatment, option, locale))
  );
  const voucher = quotes.some(({ verified }) =>
    verified.options.some(x => x.voucher));
  const voucherNote = voucher
    ? locale.startsWith("ms")
      ? "\nBaucar RM100 tertakluk pada kelayakan dan baki yang disahkan oleh pusat."
      : locale.startsWith("en")
        ? "\nThe RM100 voucher is subject to eligibility and remaining availability confirmed by the clinic."
        : "\nRM100 优惠券须符合活动条件，剩余名额由门店确认。"
    : "";
  const reply = locale.startsWith("ms")
    ? "Boleh 😊 Untuk bajet anda, berikut harga tawaran bagi pilihan rawatan yang dibincangkan:\n" +
      lines.join("\n") + voucherNote +
      "\n\nIni harga bagi pilihan berasingan, bukan pakej gabungan. Pengamal kami boleh menilai kesesuaian serta bilangan sesi dahulu."
    : locale.startsWith("en")
      ? "Of course 😊 For your budget, here are the currently verified offers for the treatments discussed:\n" +
        lines.join("\n") + voucherNote +
        "\n\nThese are separate options, not a combined charge. Our practitioner can assess suitability and the number of sessions first."
      : "可以的～先给你参考我们刚讨论的护理费用哦 😊\n" +
        lines.join("\n") + voucherNote +
        "\n\n以上是不同护理的独立优惠参考价，不是组合收费。是否适合及需要做几次，可以先让中医师评估后再决定 💕";

  // This format is the pre-existing text-only quote interface; it carries no
  // authorization for promo graphics. Rejected services cannot leak into
  // the verified treatment list.
  return {
    source: "verified_discussed_treatment_price_options",
    prices: quotes.map(q => ({
      treatment: q.treatment,
      amount: q.verified.options.map(p => p.price).join(" / "),
    })),
    reply,
  };
}

module.exports = { resolveNeutroPostpartumBudgetQuote };
