const { checkKeywordTriggers } = require("./attentionTriggers");

const ADMINISTRATIVE_QUESTION = /\b(price|cost|how much|fee|charges?|rate|promotion|offer|package|promo|discount|hours?|opening|closing|location|address|branch|parking|park|deposit|payment|credit card|debit card|card|cash|e-?wallet|walk-?in|receipt|invoice|appointment slot)\b|(?:价格|价钱|多少钱|收费|费用|优惠|配套|营业时间|营业|地址|地点|停车|付款|付钱|押金|定金|收据|发票|分行|预约时间|几点|几时)|\b(harga|berapa|bayaran|alamat|waktu|cawangan|parkir|promosi|diskaun|deposit|tunai|kad)\b/iu;
const CLINICAL_PROCEDURE_TIMING = /\b(after|before|recent|just had)\b.{0,40}\b(hifu|filler|botox|laser|thread|peel|injection|procedure)\b|\b(hifu|filler|botox|laser|thread|peel|injection)\b.{0,40}\b(after|before|recent|just had)\b/iu;
const CLINICAL_QUESTION = /\b(?:pregnan\w*|breastfeed\w*|postpartum|c[.-]?section\w*|surgery|surgical|procedure\w*|suitab\w*|safe to|pain\w*|symptom\w*|bleed\w*|infection\w*|medicin\w*|medication\w*|diagnos\w*|uterus|incontinen\w*|prolapse\w*|allerg\w*|wound\w*|side effects?|contraindicat\w*|treatment suitability|treatment risk|after treatment|after surgery|just had|recent procedure|can i do|is it safe|can i receive)\b|(?:怀孕|孕期|哺乳|产后|剖腹|手术|医药|药物|安全|适合|疼痛|流血|出血|尿失禁|子宫|过敏|副作用|诊断|宫颈|医生|中医师|整骨风险)|\b(hamil|menyusu|bersalin|pembedahan|ubat|selamat|sakit|darah|alahan)\b/iu;

// Never trust an unsupported/unclear category as permission for unsolicited
// sales automation. Allow informational follow-ups only for clear admin queries.
function categorizeAiReview(customerText, proposedCategory) {
  if (proposedCategory !== "information") return "clinical";
  const text = String(customerText || "");
  if (!ADMINISTRATIVE_QUESTION.test(text) ||
      CLINICAL_QUESTION.test(text) ||
      CLINICAL_PROCEDURE_TIMING.test(text) ||
      checkKeywordTriggers(text)) return "clinical";
  return "information";
}

function isAiReviewOnlyAttention(contact) {
  return contact?.mode === "ai" &&
    contact?.needs_attention === true &&
    String(contact?.attention_reason || "").startsWith("AI review requested:");
}

function canSendReactiveMedia(contact) {
  return contact?.needs_attention !== true || isAiReviewOnlyAttention(contact);
}

// Other follow-up constraints (windows, opt-outs, genuine staff takeovers,
// delivery receipts) remain unchanged; only the attention gate is narrowed.
function followUpAttentionAllowedSql(alias = "c") {
  if (!/^[a-z][a-z0-9_]*$/i.test(alias)) throw new Error("Invalid SQL contact alias");
  return `(${alias}.mode = 'ai' AND (
    ${alias}.needs_attention = false OR (
      ${alias}.mode = 'ai'
      AND ${alias}.attention_reason LIKE 'AI review requested:%'
    )
  ) AND NOT EXISTS (
    SELECT 1 FROM ai_review_items review
    WHERE review.contact_id = ${alias}.id
      AND review.status = 'pending'
      AND review.category <> 'information'
  ))`;
}

module.exports = {
  categorizeAiReview,
  isAiReviewOnlyAttention,
  canSendReactiveMedia,
  followUpAttentionAllowedSql,
};
