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

// A first-trial/free inclusion may be limited to new customers even without
// "only"/"仅限". Verify the eligibility wording as well as the service itself.
const FIRST_TRIAL_SOURCE = /(?:首次(?:体验|體驗|到店|来店|來店|护理|護理|治疗|治療|消费|消費|使用|预约|預約)?|初次(?:体验|體驗|到店|护理|護理)?|第一次(?:体验|體驗|到店|来店|來店|护理|護理)?|首访|首訪|新(?:顾客|顧客|客户|客戶|客人)|first[-\s]+(?:time|trial|visit|session|treatment|appointment)|new[-\s]+(?:customer|client|patient)|(?:pelanggan|pesakit)\s+baru|(?:kali|lawatan|rawatan|percubaan)\s+pertama)/iu;
const FIRST_TRIAL_TRANSLATION = /(?:first[-\s]+(?:time|trial|visit|session|treatment|appointment)|new[-\s]+(?:customers?|clients?|patients?)|(?:pelanggan|pesakit)\s+baru|(?:kali|lawatan|rawatan|percubaan)\s+pertama|首次(?:体验|體驗|到店|护理|護理)?|初次(?:体验|體驗)?|第一次(?:体验|體驗)?|新(?:顾客|顧客|客户|客戶|客人))/iu;

// Reject the *meaning* of a negated inclusion, even if the literal words
// "free meridian massage" appear. Never send the contradictory AI text.
const NEGATED_INCLUSION = /(?:\b(?:not|never|don['’]?t|doesn['’]?t|didn['’]?t|can['’]?t|couldn['’]?t|isn['’]?t|aren['’]?t|won['’]?t|without|unavailable|excluded|excluding|extra\s+(?:payment|charge|fee)|additional\s+(?:payment|charge|fee)|(?:need|needs|required|must|have)\s+to\s+pay|pay\s+(?:extra|additional)|not\s+free|not\s+included|not\s+available|not\s+offered|no\s+free)\b|不(?:包含|包括|赠送|贈送|提供|免费|免費)|沒有|没有|需(?:额外|額外)?付费|需要(?:额外|額外)?付款|不可免费|不可免費|\b(?:tidak|tak|bukan)\s+(?:termasuk|percuma|disediakan|diberi)\b|\b(?:kena|perlu)\s+bayar\b)/iu;

function sourcePromisesFreeMeridian(source) {
  return FREE_MARKER.test(source) && MERIDIAN_ITEM.test(source);
}

function replyClauses(response) {
  return String(response || "").split(/[\n。！？!?;；.]+/u).map((part) => part.trim()).filter(Boolean);
}

function hasContradictoryFreeMeridianClaim(source, response) {
  if (!sourcePromisesFreeMeridian(source)) return false;
  return replyClauses(response).some(
    (part) =>
      (TRANSLATED_FREE_MERIDIAN.test(part) || MERIDIAN_ITEM.test(part)) &&
      NEGATED_INCLUSION.test(part)
  );
}

function hasVerifiedFreeMeridian(source, response) {
  const hasFirstTrialCondition = FIRST_TRIAL_SOURCE.test(source);
  return replyClauses(response).some((part) =>
    TRANSLATED_FREE_MERIDIAN.test(part) &&
    !NEGATED_INCLUSION.test(part) &&
    (!hasFirstTrialCondition || FIRST_TRIAL_TRANSLATION.test(part))
  );
}


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
    if (freeMeridian && !hasOtherOfferConditions && hasVerifiedFreeMeridian(source, response)) {
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
  // Don't append the correct source after an actively contradictory AI claim:
  // the customer could otherwise see both "not included" and "included".
  if (original && hasContradictoryFreeMeridianClaim(original, reply)) {
    return {
      reply: original,
      usedOriginalFallback: true,
      missingCount: Math.max(1, missing.length),
    };
  }
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
