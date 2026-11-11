"use strict";

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

function planNeutroReviewContinuation({ customerText, conversationHistory, language } = {}) {
  const message = String(customerText || "").trim();
  if (message.length > 100) return null;
  const locale = String(language || "").toLowerCase();
  const malay = locale.startsWith("ms");
  const english = locale.startsWith("en");
  if (AFFIRMATIVE.test(message)) {
    const previousQuestion = lastAssistant(conversationHistory);
    const recentCustomers = (Array.isArray(conversationHistory) ? conversationHistory : [])
      .filter(item => item?.role === "user").slice(-5);
    if (!OFFICE_QUESTION.test(previousQuestion) ||
        !/[吗嗎?？]/u.test(previousQuestion) ||
        !recentCustomers.some(item => SMALL_BELLY.test(String(item.content || "")))) return null;
    return {
      kind: "lifestyle_confirmation",
      reply: malay
        ? "Faham 😊 Duduk lama boleh berkait dengan ketidakselesaan postur, tetapi puncanya perlu dinilai dahulu. Untuk masalah kebocoran air kencing yang disebut tadi, sebaiknya dapatkan pemeriksaan doktor. Nak tahu tentang penilaian postur atau harga rawatan dahulu?"
        : english
          ? "Got it 😊 We can first discuss your posture and sitting habits. Your earlier urine leakage concern needs a doctor's assessment, as its cause cannot be confirmed in chat. Would you prefer to know about the posture assessment or treatment prices first?"
          : "明白哦～长期久坐的话，可以先了解一下你的体态情况😊 你之前提到的漏尿问题则建议让医生评估原因，不能单凭聊天判断。你想先了解体态评估，还是项目收费呢？",
    };
  }
  if (PRICE_FIRST.test(message)) {
    return {
      kind: "unscoped_price_clarification",
      reply: malay
        ? "Boleh 😊 Awak nak tahu harga rawatan manual badan/pelvis atau Pulse Wave dahulu? Saya boleh semak rawatan yang betul untuk awak."
        : english
          ? "Of course 😊 Would you like the price for manual body/pelvic care or Pulse Wave first? I can help with the correct treatment details."
          : "可以的～😊 你想先了解身体徒手／骨盆调理，还是脉冲波的收费呢？我可以按你想了解的项目介绍。",
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
