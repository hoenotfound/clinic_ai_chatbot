"use strict";

// A staff-uploaded JPEG can have no promotion URL in messages.media_url.
// Only treat it as the same promo when the saved caption is independently
// distinctive: same ordered RM amounts and very similar actual copy.
// Similarity is never used to select a treatment or authorize a send.
function normalizedCopy(value) {
  return String(value || "").normalize("NFKC")
    .replace(/[\uFE0F\u20E3]/gu, "")
    .toLocaleLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}
function amountsInCopy(value) {
  const cleaned = String(value || "").normalize("NFKC")
    .replace(/[\uFE0F\u20E3]/gu, "");
  return [...cleaned.matchAll(/(?:RM|MYR)\s*([1-9]\d{1,4})/giu)]
    .map(match => match[1]);
}
function trigrams(text) {
  const chars = Array.from(text);
  const counts = new Map();
  for (let i = 0; i < chars.length - 2; i++) {
    const term = chars.slice(i, i + 3).join("");
    counts.set(term, (counts.get(term) || 0) + 1);
  }
  return counts;
}
function sameManuallyUploadedPromotionCaption(expected, delivered) {
  const wanted = normalizedCopy(expected), seen = normalizedCopy(delivered);
  // Generic captions such as "promo image" cannot suppress media.
  if (wanted.length < 55 || seen.length < 55) return false;
  const expectedAmounts = amountsInCopy(expected);
  const deliveredAmounts = amountsInCopy(delivered);
  if (expectedAmounts.length < 2 ||
      expectedAmounts.join(",") !== deliveredAmounts.join(",")) return false;
  const left = trigrams(wanted), right = trigrams(seen);
  const total = Math.max(0, wanted.length - 2) + Math.max(0, seen.length - 2);
  if (!total) return false;
  let overlap = 0;
  for (const [gram, count] of left) {
    overlap += Math.min(count, right.get(gram) || 0);
  }
  return 2 * overlap / total >= 0.9;
}
module.exports = { sameManuallyUploadedPromotionCaption };
