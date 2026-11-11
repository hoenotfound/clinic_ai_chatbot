"use strict";

const { hasClinicalMediaRisk } = require("./aiReviewPolicy");
const { hasExplicitPriceRequest } = require("./customerEnquiryEvidence");
const { safeServiceFromCustomer } = require("./initialOfferReplyGuard");
const { resolveVerifiedPriceFollowUpService } = require("./priceFollowUpContext");
const { verifiedPricesForService } = require("./verifiedPriceReply");

// Conservative, text-only continuity for Neutro's clinical-review workflow.
// These replies clarify the patient's intent; none diagnose a symptom,
// establish suitability, quote an unverified price, or approve marketing.
const AFFIRMATIVE = /^(?:是的|对|對|对的|對的|嗯|嗯对|嗯對|是啊|对啊|對啊|yes|yep|yeah|ya|betul)[\s.,!?？。！～~😊🙂👍]*$/iu;
const PRICE_FIRST = /^(?:(?:我)?想(?:先)?(?:了解|知道|问问|問問|看)(?:一下)?(?:价格|價錢|价钱|收費|收费)(?:先)?|(?:请问|請問)?(?:价格|價錢|价钱|收费|收費)(?:先)?|(?:can i (?:know|ask) (?:the )?price(?: first)?|price first|how much first|berapa harga(?: dulu)?))[\s.,!?？。！～~]*$/iu;
const OFFICE_QUESTION = /(?:久坐|坐办公室|坐辦公室|长时间.{0,8}坐|長時間.{0,8}坐|sit(?:ting)? (?:at (?:the )?office|for long)|duduk lama)/iu;
const SMALL_BELLY = /(?:久坐|小腹|office|sitting|duduk lama)/iu;
const URINARY = /(?:漏尿|尿失禁|urinary\s+(?:leak(?:age)?|incontinence)|leaking urine|kencing\s+(?:bocor|tak tahan))/iu;

function lastAssistant(history) {
  if (!Array.isArray(history)) return "";
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index]?.role === "assistant") return String(history[index].content || "");
  }
  return "";
}

function verifiedReviewPriceQuote({
  message, conversationHistory, language, services, serviceAliases, promotions,
} = {}) {
  if (!PRICE_FIRST.test(String(message || "")) ||
      !hasExplicitPriceRequest(message) || hasClinicalMediaRisk(message)) return null;
  const turns = Array.isArray(conversationHistory) ? conversationHistory : [];
  const activeServices = Array.isArray(services) ? services : [];
  const activePromotions = Array.isArray(promotions) ? promotions : [];
  // First try the same verified customer-led pricing context used by the
  // ordinary sales path. Do not borrow treatment names from ads or AI guesses.
  let selected = resolveVerifiedPriceFollowUpService({
    customerText: message, conversationHistory: turns, services: activeServices,
    serviceAliases, promotions: activePromotions, allowContinuedPriceContext: true,
  });
  if (!selected) {
    const earlier = turns.at(-1)?.role === "user" &&
      String(turns.at(-1).content || "").trim() === String(message).trim()
      ? turns.slice(0, -1) : turns;
    const lastCustomerIndex = earlier.findLastIndex(x => x?.role === "user");
    const lastCustomer = earlier[lastCustomerIndex];
    const choice = String(lastCustomer?.content || "").trim();
    // The exact previous customer selection is sufficient only when no
    // different topic/staff turn intervened. "3D or 9D?" is not a selection.
    if (!choice || hasClinicalMediaRisk(choice) ||
        !/(?:想了解|想知道|有兴趣|有興趣|感兴趣|感興趣|想问|想問|interested|berminat|nak\s+tahu)/iu.test(choice)) {
      return null;
    }
    if (earlier.slice(lastCustomerIndex + 1).some(x =>
      x?.role === "assistant" &&
      (x.pricingStaffAuthored === true || x.sent_by_username ||
        /^\[Verified STAFF message\]/u.test(String(x.content || ""))))) return null;
    selected = safeServiceFromCustomer(choice, activeServices, serviceAliases);
  }
  if (!selected?.name || !activeServices.some(s => s?.name === selected.name)) return null;
  const prices = verifiedPricesForService(
    selected.name, activePromotions, message, turns, { allowTextOnlyOffers: true }
  );
  if (!Array.isArray(prices) || !prices.length ||
      prices.some(p => !/^RM[1-9]\d{1,4}$/u.test(String(p.price || "")))) return null;
  const locale = String(language || "").toLowerCase();
  const labels = prices.map(p => [p.name === "Main offer" ? "" : p.name, p.price]
    .filter(Boolean).join(": ")).join(locale.startsWith("zh") ? "；" : "; ");
  const voucher = prices.some(p => p.afterVoucher)
    ? (locale.startsWith("ms")
      ? " Harga selepas baucar tertakluk pada syarat kelayakan."
      : locale.startsWith("en")
        ? " After-voucher prices are subject to eligibility."
        : " 若为优惠券后价格，需符合优惠券使用条件。") : "";
  return {
    treatment: selected.name,
    reply: locale.startsWith("ms")
      ? "Boleh 😊 Harga promosi semasa untuk " + selected.name + ": " + labels + "." + voucher
      : locale.startsWith("en")
        ? "Of course 😊 The current verified offer for " + selected.name + ": " + labels + "." + voucher
        : "可以的～😊 " + selected.name + " 目前的优惠价：" + labels + "。" + voucher,
  };
}

function planNeutroReviewContinuation({
  customerText, conversationHistory, language, services, serviceAliases, promotions,
} = {}) {
  const message = String(customerText || "").trim();
  if (message.length > 100) return null;
  const locale = String(language || "").toLowerCase();
  const malay = locale.startsWith("ms");
  const english = locale.startsWith("en");
  const recentCustomers = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(item => item?.role === "user").slice(-7)
    .map(item => String(item.content || ""));
  if (AFFIRMATIVE.test(message)) {
    const previousQuestion = lastAssistant(conversationHistory);
    if (!OFFICE_QUESTION.test(previousQuestion) ||
        !/[吗嗎?？]/u.test(previousQuestion) ||
        !recentCustomers.some(value => SMALL_BELLY.test(value))) return null;
    const priorLeakage = recentCustomers.some(value => URINARY.test(value));
    const leakageNote = malay
      ? " Untuk masalah kebocoran air kencing yang disebut tadi, sebaiknya dapatkan pemeriksaan doktor."
      : english
        ? " Your earlier urine leakage concern needs a doctor's assessment, as its cause cannot be confirmed in chat."
        : " 你之前提到的漏尿问题则建议让医生评估原因，不能单凭聊天判断。";
    return {
      kind: "lifestyle_confirmation",
      reply: malay
        ? "Faham 😊 Kita boleh bincangkan tabiat duduk dan postur terlebih dahulu." +
          (priorLeakage ? leakageNote : "") +
          " Nak tahu tentang penilaian postur atau harga rawatan dahulu?"
        : english
          ? "Got it 😊 We can first discuss your posture and sitting habits." +
            (priorLeakage ? leakageNote : "") +
            " Would you prefer to know about the posture assessment or treatment prices first?"
          : "明白哦～长期久坐的话，可以先了解一下你的体态情况😊" +
            (priorLeakage ? leakageNote : "") +
            " 你想先了解体态评估，还是项目收费呢？",
    };
  }
  if (PRICE_FIRST.test(message)) {
    const verified = verifiedReviewPriceQuote({
      message, conversationHistory, language, services, serviceAliases, promotions,
    });
    if (verified) return { kind: "verified_price", reply: verified.reply,
      treatment: verified.treatment };
    // The patient's latest stated concern, not an older ad or an unrelated
    // service in the history, determines which clarification choices to show.
    const latestConcern = recentCustomers.slice(-4).reverse()
      .find(value => /(?:身体|身體|骨盆|盆骨|小腹|3\s*d|9\s*d|小颜|小顏|逆龄|逆齡|脉冲|脈衝|pelvic|facial|pulse wave)/iu.test(value)) || "";
    const body = /(?:身体|身體|骨盆|盆骨|小腹|pelvic)/iu.test(latestConcern) &&
      !/(?:3\s*d|9\s*d|小颜|小顏|逆龄|逆齡|facial)/iu.test(latestConcern);
    const choices = body
      ? (malay
        ? "Awak nak tahu harga rawatan manual badan/pelvis atau Pulse Wave dahulu?"
        : english
          ? "Would you like the price for manual body/pelvic care or Pulse Wave first?"
          : "你想先了解身体徒手／骨盆调理，还是脉冲波的收费呢？")
      : (malay
        ? "Rawatan yang mana awak nak tahu harganya dahulu?"
        : english
          ? "Which treatment would you like the price for first?"
          : "你想先了解哪一项护理的收费呢？");
    return {
      kind: "unscoped_price_clarification",
      reply: (malay ? "Boleh 😊 " : english ? "Of course 😊 " : "可以的～😊 ") + choices,
    };
  }
  return null;
}

function nonUrgentUrinaryAcknowledgement(customerText, language) {
  if (!URINARY.test(String(customerText || ""))) return null;
  const locale = String(language || "").toLowerCase();
  if (locale.startsWith("ms")) {
    return "Terima kasih kerana berkongsi 😊 Masalah kebocoran air kencing boleh mempunyai pelbagai punca. Sebaiknya dapatkan pemeriksaan doktor untuk mengetahui puncanya. Kami boleh bantu terangkan penilaian postur secara berasingan, tanpa menganggap rawatan postur boleh menyelesaikan masalah ini.";
  }
  if (locale.startsWith("en")) {
    return "Thanks for sharing 😊 Urine leakage can have different causes, so a doctor should assess it. We can explain our posture assessment separately, but cannot assume a posture treatment would resolve the leakage.";
  }
  return "谢谢你告诉我们哦😊 漏尿可能有不同原因，建议先让医生评估，不能单凭聊天判断。体态方面我们可以另外介绍评估内容，但不能直接认为体态调理就能改善漏尿。";
}

module.exports = { planNeutroReviewContinuation, nonUrgentUrinaryAcknowledgement };
