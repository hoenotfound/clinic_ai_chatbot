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

function isComplimentaryAssessmentFeeQuestion(customerText, enabled = false) {
  const text = String(customerText || "").normalize("NFKC").trim();
  return enabled === true && text.length > 0 &&
    ASSESSMENT.test(text) && (FEE_QUESTION.test(text) || ASK_IF_FREE.test(text)) &&
    !FULL_TREATMENT.test(text);
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

module.exports = {
  isComplimentaryAssessmentFeeQuestion,
  complimentaryAssessmentFeeReply,
};
