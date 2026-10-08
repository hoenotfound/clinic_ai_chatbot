// A language model can be asked to preserve a clinic's saved introduction,
// but its translated prose cannot be assumed to preserve exact offer amounts,
// links, contact details or service codes. When any checkable literal is lost,
// append the original clinic introduction rather than silently dropping facts.
const PROTECTED_FACT_PATTERNS = [
  /https?:\/\/[^\s<>]+/giu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
  /\b(?:RM|MYR)\s*[\d,]+(?:\.\d+)?\b/giu,
  /(?:\+?60|0)[\d\s()-]{7,18}\d/gu,
  /\b\d+(?:\.\d+)?\s*%/gu,
  /\b(?:3D|9D)\b/giu,
];

// Offers that do not contain a price (e.g. 免费经络按摩) still carry
// contractual information. Generic "free" or "massage" in a translation
// must not count as proof that the actual inclusion was retained.
const OFFER_CLAIM = /(?:\b(?:free|complimentary|percuma|gratis|voucher|coupon|gift|bonus|included|promotion|promo|discount|offer|valid\s+only|subject\s+to|terms\s+and\s+conditions)\b|免费|免費|赠送|贈送|附送|送你|送您|优惠券|優惠券|代金券|抵用券|礼券|禮券|限时|限時|仅限|僅限|只限|新客户专享|新客專享|附带条件|附帶條件|适用条件|適用條件)/iu;
const FREE_MARKER = /(?:\b(?:free|complimentary|percuma|gratis)\b|免费|免費|赠送|贈送|附送)/iu;
const MERIDIAN_ITEM = /(?:经络按摩|經絡按摩|\bmeridian(?:\s+\w+){0,2}\s+(?:massage|therapy)\b|\burut(?:an)?\s+meridian\b)/iu;
const TRANSLATED_FREE_MERIDIAN = /(?:\b(?:free|complimentary|percuma|gratis)\b[\s\S]{0,75}\b(?:meridian(?:\s+\w+){0,2}\s+(?:massage|therapy)|urut(?:an)?\s+meridian)\b|\b(?:meridian(?:\s+\w+){0,2}\s+(?:massage|therapy)|urut(?:an)?\s+meridian)\b[\s\S]{0,75}\b(?:free|complimentary|percuma|gratis)\b|(?:免费|免費|赠送|贈送|附送).{0,40}(?:经络按摩|經絡按摩)|(?:经络按摩|經絡按摩).{0,40}(?:免费|免費|赠送|贈送|附送))/iu;

function missingProtectedOfferClaims(original, generatedReply) {
  const source = String(original || "");
  const response = String(generatedReply || "");
  const normalizedReply = comparableLiteral(response);
  const missing = [];

  // Protect each offer/eligibility clause separately. If a translation can't
  // be checked deterministically, include the full original rather than
  // incorrectly accepting a vague paraphrase (e.g. "a free massage").
  for (const clause of source.split(/[\n。！!?；;]+/u).map((part) => part.trim()).filter(Boolean)) {
    if (!OFFER_CLAIM.test(clause)) continue;
    if (normalizedReply.includes(comparableLiteral(clause))) continue;

    const freeMeridian = FREE_MARKER.test(clause) && MERIDIAN_ITEM.test(clause);
    const hasOtherOfferConditions =
      /(?:\b(?:voucher|coupon|gift|bonus|discount|valid|subject|terms|conditions|only)\b|优惠券|優惠券|代金券|抵用券|礼券|禮券|限时|限時|仅限|僅限|只限|新客|條件|条件)/iu.test(clause);
    if (freeMeridian && !hasOtherOfferConditions && TRANSLATED_FREE_MERIDIAN.test(response)) {
      continue;
    }
    missing.push(clause);
  }
  return missing;
}

function comparableLiteral(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[\s()\-\u2013\u2014]/gu, "");
}

function missingProtectedIntroFacts(configuredIntro, generatedReply) {
  const intro = String(configuredIntro || "");
  const reply = comparableLiteral(generatedReply);
  const literals = new Set();
  for (const pattern of PROTECTED_FACT_PATTERNS) {
    for (const match of intro.matchAll(pattern)) {
      const value = match[0].replace(/[.,;:!？。]+$/u, "");
      if (value) literals.add(value);
    }
  }
  const missingLiterals = [...literals].filter((value) => !reply.includes(comparableLiteral(value)));
  return [...new Set([...missingLiterals, ...missingProtectedOfferClaims(intro, generatedReply)])];
}

function preserveOriginalIntroFacts(configuredIntro, generatedReply) {
  const original = String(configuredIntro || "").trim();
  const reply = String(generatedReply || "").trim();
  const missing = missingProtectedIntroFacts(original, reply);
  if (!original || missing.length === 0 || reply.includes(original)) {
    return { reply, usedOriginalFallback: false, missingCount: 0 };
  }

  // Fail-safe for unverifiable AI translation: facts remain accessible without
  // inventing a translated price, voucher condition, contact or treatment.
  return {
    reply: [reply, "Original clinic introduction:", original].join("\n\n"),
    usedOriginalFallback: true,
    missingCount: missing.length,
  };
}

module.exports = { missingProtectedIntroFacts, preserveOriginalIntroFacts };
