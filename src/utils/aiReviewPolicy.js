const { checkKeywordTriggers } = require("./attentionTriggers");

const ADMINISTRATIVE_QUESTION = /\b(price|cost|how much|fee|charges?|rate|promotion|offer|package|promo|discount|hours?|opening|closing|location|address|branch|parking|park|deposit|payment|credit card|debit card|card|cash|e-?wallet|walk-?in|receipt|invoice|appointment slot)\b|(?:价格|价钱|多少钱|收费|费用|优惠|配套|营业时间|营业|地址|地点|停车|付款|付钱|押金|定金|收据|发票|分行|预约时间|几点|几时)|\b(harga|berapa|bayaran|alamat|waktu|cawangan|parkir|promosi|diskaun|deposit|tunai|kad)\b/iu;
const CLINICAL_PROCEDURE_TIMING = /\b(after|before|recent|just had)\b.{0,40}\b(hifu|filler|botox|laser|thread|peel|injection|procedure)\b|\b(hifu|filler|botox|laser|thread|peel|injection)\b.{0,40}\b(after|before|recent|just had)\b/iu;
const CLINICAL_QUESTION = /\b(?:pregnan\w*|breastfeed\w*|postpartum|c[.-]?section\w*|surgery|surgical|procedure\w*|suitab\w*|safe to|pain\w*|symptom\w*|bleed\w*|infection\w*|medicin\w*|medication\w*|diagnos\w*|uterus|incontinen\w*|prolapse\w*|allerg\w*|wound\w*|side effects?|contraindicat\w*|treatment suitability|treatment risk|after treatment|after surgery|just had|recent procedure|can i do|is it safe|can i receive)\b|(?:怀孕|懷孕|孕期|孕婦|孕妇|懷胎|怀胎|胎兒|胎儿|哺乳|餵奶|喂奶|產後|产后|術後|术后|剖腹|手術|手术|醫藥|医药|藥物|药物|藥|药|安全|適合|适合|疼痛|流血|出血|尿失禁|子宮|子宫|過敏|过敏|副作用|診斷|诊断|宮頸|宫颈|醫生|医生|中醫師|中医师|整骨風險|整骨风险|坐月子)|\b(hamil|mengandung|kandungan|berbadan dua|preggy|menyusu\w*|bersalin|pembedahan|ubat|selamat|sakit|darah|alahan|sesuai|risiko|keguguran|gugur|doktor|kesan sampingan)\b/iu;

const MEDICAL_HISTORY = /\b(?:diabet(?:es|ic)|cancer|hypertension|high blood pressure|pcos|polycystic|thyroid|heart disease|kidney disease|kencing manis|darah tinggi|kanser|buah pinggang|sakit jantung)\b|(?:糖尿病|高血压|高血壓|癌症|多囊卵巢|心脏病|心臟病|肾病|腎病)/iu;

// This is a separate media-only gate. The broader AI review classifier
// includes terms such as "子宫" for cautious staff triage. An ordinary price
// enquiry for a configured "子宫套餐" is not itself a contraindication and
// must not be blocked merely because the package name sounds clinical.
const CLINICAL_MEDIA_RED_FLAGS =
  /\b(?:pregnan\w*|breastfeed\w*|postpartum|c[.-]?section\w*|surgery|surgical|operation|procedure\w*|suitab\w*|safe(?:ty)?|risk\w*|pain\w*|symptom\w*|bleed\w*|infection\w*|medicin\w*|medication\w*|diagnos\w*|incontinen\w*|prolapse\w*|allerg\w*|wound\w*|side effects?|contraindicat\w*|after treatment|after surgery|just had|recent procedure|can i do|can i receive)\b|(?:怀孕|懷孕|孕期|孕婦|孕妇|懷胎|怀胎|胎兒|胎儿|哺乳|餵奶|喂奶|產後|产后|術後|术后|剖腹|手術|手术|醫藥|医药|藥物|药物|安全|適合|适合|疼痛|流血|出血|尿失禁|過敏|过敏|副作用|診斷|诊断|宮頸|宫颈|整骨風險|整骨风险|坐月子|可以做吗|可以做嗎|能做吗|能做嗎)|\b(?:hamil|mengandung|kandungan|berbadan dua|preggy|menyusu\w*|bersalin|pembedahan|ubat|selamat|sakit|darah|alahan|sesuai|risiko|keguguran|gugur|kesan sampingan)\b/iu;

// If AI misses a clinical outcome flag, images still fail closed here. Keep
// this separate from review categorization, which has different purposes.
const CLINICAL_MEDIA_SUITABILITY =
  /(?:可不可以|能不能|是否可以|可以|能否|适不适合|適不適合)(?:.{0,15})(?:做|用|接受|进行|進行)(?:.{0,10})(?:吗|嗎|呢|\?|？)|(?:can|could|should)\s+i\s+(?:have|receive|undergo|try|do)\s+(?:this|the|a|your)?\s*(?:treatment|procedure|therapy|rawatan)|\b(?:am i|is it)\s+(?:eligible|suitable|safe)\b|\b(?:boleh|sesuai)\s+(?:buat|cuba|jalani|rawatan|ke)\b/iu;

function hasClinicalMediaRisk(customerText) {
  const value = String(customerText || "");
  return CLINICAL_MEDIA_SUITABILITY.test(value) ||
    CLINICAL_MEDIA_RED_FLAGS.test(value) ||
    CLINICAL_PROCEDURE_TIMING.test(value) ||
    MEDICAL_HISTORY.test(value) ||
    Boolean(checkKeywordTriggers(value));
}

// Never trust an unsupported/unclear category as permission for unsolicited
// sales automation. Allow informational follow-ups only for clear admin queries.
function categorizeAiReview(customerText, proposedCategory) {
  if (proposedCategory !== "information") return "clinical";
  const text = String(customerText || "");
  if (!ADMINISTRATIVE_QUESTION.test(text) ||
      CLINICAL_QUESTION.test(text) ||
      CLINICAL_PROCEDURE_TIMING.test(text) ||
      MEDICAL_HISTORY.test(text) ||
      checkKeywordTriggers(text)) return "clinical";
  return "information";
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
  hasClinicalMediaRisk,
  followUpAttentionAllowedSql,
};
