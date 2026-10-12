const { checkKeywordTriggers } = require("./attentionTriggers");

const ADMINISTRATIVE_QUESTION = /\b(price|cost|how much|fee|charges?|rate|promotion|offer|package|promo|discount|hours?|opening|closing|location|address|branch|parking|park|deposit|payment|credit card|debit card|card|cash|e-?wallet|walk-?in|receipt|invoice|appointment slot)\b|(?:价格|价钱|多少钱|收费|费用|优惠|配套|营业时间|营业|地址|地点|停车|付款|付钱|押金|定金|收据|发票|分行|预约时间|几点|几时)|\b(harga|berapa|bayaran|alamat|waktu|cawangan|parkir|promosi|diskaun|deposit|tunai|kad)\b/iu;
const CLINICAL_PROCEDURE_TIMING = /\b(after|before|recent|just had)\b.{0,40}\b(hifu|filler|botox|laser|thread|peel|injection|procedure)\b|\b(hifu|filler|botox|laser|thread|peel|injection)\b.{0,40}\b(after|before|recent|just had)\b/iu;
const CLINICAL_QUESTION = /\b(?:pregnan\w*|breastfeed\w*|postpartum|c[.-]?section\w*|surgery|surgical|procedure\w*|suitab\w*|safe to|pain\w*|symptom\w*|bleed\w*|infection\w*|medicin\w*|medication\w*|diagnos\w*|uterus|incontinen\w*|prolapse\w*|allerg\w*|wound\w*|side effects?|contraindicat\w*|treatment suitability|treatment risk|after treatment|after surgery|just had|recent procedure|can i do|is it safe|can i receive)\b|(?:怀孕|懷孕|孕期|孕婦|孕妇|懷胎|怀胎|胎兒|胎儿|哺乳|餵奶|喂奶|產後|产后|術後|术后|剖腹|手術|手术|醫藥|医药|藥物|药物|藥|药|安全|適合|适合|疼痛|会不会很痛|會不會很痛|会不会痛|會不會痛|会痛吗|會痛嗎|流血|出血|尿失禁|子宮|子宫|過敏|过敏|副作用|診斷|诊断|宮頸|宫颈|醫生|医生|中醫師|中医师|整骨風險|整骨风险|坐月子)|\b(hamil|mengandung|kandungan|berbadan dua|preggy|menyusu\w*|bersalin|pembedahan|ubat|selamat|sakit|darah|alahan|sesuai|risiko|keguguran|gugur|doktor|kesan sampingan)\b/iu;

const MEDICAL_HISTORY = /\b(?:diabet(?:es|ic)|cancer|hypertension|high blood pressure|pcos|polycystic|thyroid|heart disease|kidney disease|kencing manis|darah tinggi|kanser|buah pinggang|sakit jantung)\b|(?:糖尿病|高血压|高血壓|癌症|多囊卵巢|心脏病|心臟病|肾病|腎病)/iu;

// This is a separate media-only gate. The broader AI review classifier
// includes terms such as "子宫" for cautious staff triage. An ordinary price
// enquiry for a configured "子宫套餐" is not itself a contraindication and
// must not be blocked merely because the package name sounds clinical.
const CLINICAL_MEDIA_RED_FLAGS =
  /\b(?:pregnan\w*|breastfeed\w*|c[.-]?section\w*|surgery|surgical|operation|procedure\w*|suitab\w*|safe(?:ty)?|risk\w*|pain\w*|symptom\w*|bleed\w*|infection\w*|medicin\w*|medication\w*|diagnos\w*|incontinen\w*|prolapse\w*|allerg\w*|wound\w*|side effects?|contraindicat\w*|after treatment|after surgery|just had|recent procedure|can i do|can i receive)\b|(?:怀孕|懷孕|孕期|孕婦|孕妇|懷胎|怀胎|胎兒|胎儿|哺乳|餵奶|喂奶|術後|术后|剖腹|手術|手术|醫藥|医药|藥物|药物|安全|適合|适合|疼痛|会不会很痛|會不會很痛|会不会痛|會不會痛|会痛吗|會痛嗎|流血|出血|尿失禁|過敏|过敏|副作用|診斷|诊断|宮頸|宫颈|整骨風險|整骨风险|坐月子|可以做吗|可以做嗎|能做吗|能做嗎)|\b(?:hamil|mengandung|kandungan|berbadan dua|preggy|menyusu\w*|bersalin|pembedahan|ubat|selamat|sakit|darah|alahan|sesuai|risiko|keguguran|gugur|kesan sampingan)\b/iu;

// "产后" / "postpartum" is also a configured treatment name, not
// automatically a contraindication. Recent childbirth and recovery remain
// safety signals; ordinary treatment/package interest is not one.
const RECENT_POSTPARTUM_RISK =
  /(?:刚|剛|刚刚|剛剛|才|不久前)(?:.{0,8})(?:生完|生产|生產|分娩|坐完月子|剖腹)|(?:产后|產後|生产后|生產後)(?:\s*(?:不到|才|刚|剛|仅|僅|只有))?\s*(?:(?:[1-6]|[一二三四五六])\s*(?:天|周|週|星期)|(?:一|两|兩|三)\s*(?:个|個)?(?:星期|周|週))|\b(?:just|recently)\s+(?:gave\s+birth|delivered|had\s+(?:a\s+)?baby|postpartum)|\b(?:[1-6]\s*(?:days?|weeks?)\s+(?:postpartum|after\s+(?:delivery|childbirth)))\b|\b(?:baru\s+(?:lepas\s+)?bersalin|baru\s+melahirkan|selepas\s+pembedahan)\b/iu;

// Natural-language postpartum ages include "产后7天", "产后一个月",
// "1 month postpartum" and "2 minggu selepas bersalin". The original
// fast-path regex above covers a few idioms; parse stated ages separately so
// 7+ days, Chinese numerals and months are not accidentally treated as safe.
// This is a conservative optional-media rule, not a medical eligibility claim.
const POSTPARTUM_CONTEXT = /(?:产后|產後|生产后|生產後|生完|生产|生產|分娩|postpartum|postnatal|after\s+(?:giving\s+birth|childbirth|delivery)|gave\s+birth|bersalin|melahirkan)/iu;
const POSTPARTUM_DURATION = /(?<amount>\d{1,3}|[一二两兩三四五六七八九十]+|半)(?:个|個)?\s*(?<unit>个月|個月|天|日|周|週|星期|月|days?|weeks?|months?|hari|minggu|bulan)/giu;
function postpartumAmount(raw) {
  const amount = String(raw || "").trim();
  if (/^\d{1,3}$/.test(amount)) return Number(amount);
  if (amount === "半") return 0.5;
  const values = { 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (amount === "十") return 10;
  if (amount.includes("十")) {
    const [before, after] = amount.split("十");
    if (amount.split("十").length !== 2) return null;
    return (before ? values[before] : 1) * 10 + (after ? values[after] : 0);
  }
  return values[amount] ?? null;
}
function hasRecentPostpartumInterval(customerText) {
  const value = String(customerText || "");
  for (const match of value.matchAll(POSTPARTUM_DURATION)) {
    const amount = postpartumAmount(match.groups?.amount);
    if (amount === null || !Number.isFinite(amount)) continue;
    const unit = match.groups?.unit || "";
    const recent = /^(?:天|日|days?|hari)$/iu.test(unit) ? amount <= 90
      : /^(?:周|週|星期|weeks?|minggu)$/iu.test(unit) ? amount <= 12
        : amount <= 3;
    if (!recent) continue;
    // Tie the stated age to childbirth, not a "3个月疗程" duration.
    const before = value.slice(Math.max(0, match.index - 22), match.index);
    const after = value.slice(match.index + match[0].length,
      match.index + match[0].length + 28);
    // A "3个月疗程" describes the service/package duration, not the
    // customer's age since childbirth.
    if (/^\s*(?:疗程|療程|课程|課程|配套|套餐|treatment\s+course|packages?)/iu.test(after)) {
      continue;
    }
    const closeBefore = POSTPARTUM_CONTEXT.exec(before);
    if (closeBefore && !/(?:疗程|療程|套餐|配套|课程|課程|treatment\s+course|package)/iu.test(
      before.slice(closeBefore.index + closeBefore[0].length)
    )) return true;
    if (POSTPARTUM_CONTEXT.test(after)) return true;
  }
  return false;
}

// If AI misses a clinical outcome flag, images still fail closed here. Keep
// this separate from review categorization, which has different purposes.
const CLINICAL_MEDIA_SUITABILITY =
  /(?:可不可以|能不能|是否可以|可以|能否|适不适合|適不適合)(?:.{0,15})(?:做|用|接受|进行|進行)(?:.{0,10})(?:吗|嗎|呢|\?|？)|(?:can|could|should)\s+i\s+(?:have|receive|undergo|try|do)\s+(?:(?:this|the|a|your)\s+)?(?:[\w-]+\s+){0,3}(?:treatment|procedure|therapy|rawatan)|\b(?:am i|is it)\s+(?:eligible|suitable|safe)\b|\b(?:boleh|sesuai)\s+(?:buat|cuba|jalani|rawatan|ke)\b/iu;

function hasClinicalMediaRisk(customerText) {
  const value = String(customerText || "");
  return CLINICAL_MEDIA_SUITABILITY.test(value) ||
    (hasRecentPostpartumInterval(value) || RECENT_POSTPARTUM_RISK.test(value)) ||
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
