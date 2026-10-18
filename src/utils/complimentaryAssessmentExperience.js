"use strict";

// This is an explicit per-clinic business fact, NOT an inference from the
// words "assessment" or "trial". A separate full treatment / First Trial
// session still follows the active promotion and its configured price.
const ASSESSMENT = /(?:体态评估|體態評估|身体评估|身體評估|一对一评估|一對一評估|1\s*[对對]\s*1\s*(?:的)?\s*(?:体态|體態|身体|身體)?\s*评估|評估\s*\+\s*体验|posture\s+assessment|body\s+assessment|1\s*[-–]?\s*(?:to|on)\s*[-–]?\s*1\s+assessment|penilaian\s*(?:postur|badan))/iu;
const FEE_QUESTION = /(?:收费|收費|费用|費用|多少钱|多少錢|价钱|價錢|价格|價格|要钱|要錢|要付|\b(?:no\s+charge|how\s+much|price|cost|charges?|fees?|payment|harga|bayar|berbayar)\b)/iu;
// "Book the free experience next week" is a scheduling request, not a
// question about fees. Only explicit yes/no free-cost questions use this path.
const ASK_IF_FREE = /(?:是不是|是否|会不会|會不會|有沒有|有没有)[^。!?？]{0,65}(?:免费|免費)|(?:免费|免費)(?:的)?\s*(?:吗|嗎|呢|[?？])|\b(?:is|are|was|were|does|do|would|will)\b[^.!?]{0,100}\b(?:free|complimentary)\b|\b(?:free|complimentary)\b\s*[?]|\b(?:percuma|gratis)\b\s*(?:ke|tak|kah|[?？])/iu;
const FULL_TREATMENT = /(?:\b(?:3\s*d|9\s*d|first\s*trial|full\s*(?:session|treatment|trial)|package\s*[a-c]|paid\s*(?:trial|treatment))\b|(?:正式|完整|整套|全套|整个|整個)\s*(?:疗程|療程|护理|護理|体验|體驗)|(?:配套|套餐)\s*[a-cA-C]?(?:\s*(?:价钱|价錢|价格|價格|收费|收費))?)/iu;

// A short, service-free "体验收费吗？" inherits only the *immediately prior*
// customer-named complimentary 1对1评估 + 体验. Never borrow a CRM label,
// advertisement, model inference, staff statement or an older treatment topic.
const INTRO_EXPERIENCE = /(?:体验|體驗|\b(?:introductory\s+)?experience\b|\bsesi\s+(?:pengalaman|pengenalan)\b)/iu;
const SHORT_EXPERIENCE_FEE = /^(?:(?:请问|請問|那个|那個|这个|這個|这次|這次|the|this|that)\s*){0,2}(?:体验|體驗|experience|sesi\s+(?:pengalaman|pengenalan))\s*(?:这个|這個|的|是)?\s*(?:收费|收費|费用|費用|多少钱|多少錢|价钱|價錢|价格|價格|免费|免費|要钱|要錢|要付|(?:is\s+it\s+)?(?:free|complimentary|chargeable|paid)|(?:cost|price|fee|charges?)|harga|bayar|berbayar|percuma|gratis)\s*(?:吗|嗎|呢|啊|呀|不|吗?|ke|tak|kah|[?？。!！])*\s*$/iu;
// Customers frequently ask the same fee question in spoken Chinese or English
// rather than the terse "体验收费吗？" form above. These are deliberately
// anchored fee QUESTIONS about the experience, not booking requests or
// blanket consent to receive offers. Context verification happens below.
const SHORT_CHINESE_EXPERIENCE_FEE =
  /^(?:(?:请问|請問|那|那么|那麼|所以|这个|這個|那个|那個|这次|這次)\s*){0,3}(?:体验|體驗)\s*(?:是|是不是|是否|要|需要|会|會|有|有没有|有沒有)?\s*(?:免费|免費|收费|收費|要钱|要錢|付费|付費|要付费|要付費|多少钱|多少錢|价钱|價錢|价格|價格|费用|費用)\s*(?:的)?\s*(?:吗|嗎|呢|呀|啊|不|[?？。!！])*\s*$/iu;
const SHORT_ENGLISH_EXPERIENCE_FEE =
  /^(?:(?:is|are)\s+(?:(?:the|this|that|your|our)\s+)?(?:(?:introductory|intro)\s+)?experience\s+(?:free|complimentary|chargeable|paid)|(?:does|do|will|would)\s+(?:(?:the|this|that|your|our)\s+)?(?:(?:introductory|intro)\s+)?experience\s+(?:cost\s+(?:anything|money)|(?:have|require)\s+(?:a\s+)?(?:fee|charge|payment))|(?:(?:the|this|that|your|our)\s+)?(?:(?:introductory|intro)\s+)?experience\s+(?:free|complimentary|chargeable|paid|cost\s+(?:anything|money)))\s*[?？.!！]*\s*$/iu;
const STAFF_MESSAGE = /^\[Verified STAFF message\]/u;

function recentIntroAssessmentContext(customerText, conversationHistory) {
  if (![SHORT_EXPERIENCE_FEE, SHORT_CHINESE_EXPERIENCE_FEE, SHORT_ENGLISH_EXPERIENCE_FEE]
    .some((pattern) => pattern.test(customerText))) return false;
  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter((entry) => entry?.role === "user" || entry?.role === "assistant");
  if (!turns.length) return false;
  // Some callers include the current inbound turn; others supply prior turns.
  if (turns.at(-1)?.role === "user" &&
      String(turns.at(-1)?.content || "").normalize("NFKC").trim() === customerText) turns.pop();
  let sawAssistant = false;
  let previousAssistant = null;
  let previousUser = null;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turn.role === "assistant") {
      if (STAFF_MESSAGE.test(String(turn.content || "").trim()) ||
          FULL_TREATMENT.test(String(turn.content || ""))) return false;
      if (sawAssistant) return false;
      sawAssistant = true;
      previousAssistant = String(turn.content || "").normalize("NFKC").trim();
      continue;
    }
    previousUser = String(turn.content || "").normalize("NFKC").trim();
    break;
  }
  // The customer either explicitly named the combined free offer, OR the bot
  // immediately offered that exact verified introduction in reply to a real
  // customer. Never infer a free paid trial from a treatment advert, an old
  // conversation, a staff turn, or any 3D/9D/First Trial/package context.
  return Boolean(previousUser && !FULL_TREATMENT.test(previousUser) && (
    (ASSESSMENT.test(previousUser) && INTRO_EXPERIENCE.test(previousUser)) ||
    (previousAssistant && ASSESSMENT.test(previousAssistant) &&
      INTRO_EXPERIENCE.test(previousAssistant))
  ));
}

function isComplimentaryAssessmentFeeQuestion(
  customerText, enabled = false, conversationHistory = []
) {
  const text = String(customerText || "").normalize("NFKC").trim();
  if (enabled !== true || !text || FULL_TREATMENT.test(text)) return false;
  if (ASSESSMENT.test(text) && (FEE_QUESTION.test(text) || ASK_IF_FREE.test(text))) {
    return true;
  }
  return recentIntroAssessmentContext(text, conversationHistory);
}

function complimentaryAssessmentFeeReply(language = "zh") {
  const locale = String(language || "").toLowerCase();
  if (locale.startsWith("ms")) {
    return "Ya 😊 Penilaian postur 1-ke-1 bersama sesi pengalaman pengenalan adalah percuma. Jika kemudian memilih rawatan penuh atau pakej lain, harga rawatan tersebut adalah berasingan.";
  }
  if (locale.startsWith("en")) {
    return "Yes 😊 Our 1-on-1 posture assessment + introductory experience is free. A separate full treatment or paid trial package, if you choose one later, has its own price.";
  }
  return "是的～我们中医师的1对1体态评估 + 体验是免费的 😊 如果之后选择正式疗程或其他付费配套，费用才会另外计算。";
}

// "How much?" after an invitation that discusses BOTH the introductory
// assessment and paid hands-on care is ambiguous. Never quote an unrelated
// pelvic package or describe a full treatment as free.
function ambiguousAssessmentOrTreatmentFeeReply(customerText, conversationHistory = [], language = "en") {
  const current = String(customerText || "").normalize("NFKC").trim();
  if (!/^(?:how\s+much|berapa|brapa|brp|多少钱|多少錢|几多钱|幾多錢|几钱|幾錢)[\s?？。!！]*$/iu.test(current)) return null;
  const turns = (Array.isArray(conversationHistory) ? conversationHistory : [])
    .filter(x => x?.role === "user" || x?.role === "assistant");
  const last = turns.at(-1), preceding = turns.at(-2);
  if (!last || last.role !== "user" || String(last.content || "").trim() !== current ||
      !preceding || preceding.role !== "assistant" ||
      preceding.pricingStaffAuthored === true ||
      STAFF_MESSAGE.test(String(preceding.content || "").trim())) return null;
  const answer = String(preceding.content || "");
  if (!ASSESSMENT.test(answer) || !INTRO_EXPERIENCE.test(answer) ||
      !/(?:调理|調理|疗程|療程|护理|護理|放松|放鬆|treatment|rawatan)/iu.test(answer)) return null;
  const stamp = last.pricingCreatedAtMs, previous = preceding.pricingCreatedAtMs;
  if (!Number.isFinite(stamp) || !Number.isFinite(previous) ||
      stamp < previous || stamp - previous > 24 * 60 * 60 * 1000) return null;
  const locale = /^[a-z\s?!.]+$/iu.test(current) ? "en" : String(language || "").toLowerCase();
  return locale.startsWith("ms") && /^(?:berapa|brapa|brp)/iu.test(current)
    ? "Penilaian postur 1-ke-1 + sesi pengenalan adalah percuma 😊 Rawatan penuh adalah berasingan dan harganya perlu disahkan. Awak tanya tentang penilaian atau rawatan penuh?"
    : locale.startsWith("en")
      ? "Our 1-on-1 posture assessment + introductory experience is free 😊 A separate full treatment has its own price, which the centre can confirm. Did you mean the assessment or the full treatment?"
      : "中医师的1对1体态评估 + 体验是免费的 😊 正式调理疗程会另外收费，价格需要门店确认。你想问的是免费评估体验，还是正式疗程的费用呢？";
}

module.exports = {
  isComplimentaryAssessmentFeeQuestion,
  complimentaryAssessmentFeeReply,
  ambiguousAssessmentOrTreatmentFeeReply,
};
