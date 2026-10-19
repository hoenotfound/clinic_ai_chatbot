"use strict";

// Conservative automatic-send guard for explicitly unsafe claims appearing in
// configured promotional captions or follow-up copy. Image pixels and video
// frames cannot be validated by this text-only check and still need review.
const UNSAFE_CLINICAL_CLAIM =
  /(?:90\s*%.{0,75}(?:collagen|胶原蛋白|膠原蛋白)|(?:collagen|胶原蛋白|膠原蛋白).{0,75}90\s*%|无副作用|無副作用|no\s+side\s+effects|without\s+(?:any\s+)?side\s+effects|无疼痛感|無疼痛感|(?:完全|绝对|絕對|100\s*%)\s*(?:无痛|無痛)|guaranteed\s+(?:result|outcome|cure|effect)|(?:颅骨|顱骨|头骨|頭骨)\s*(?:骨缝|骨縫).{0,24}(?:变小|變小|缩小|縮小))/iu;

function hasUnsafeClinicalPromotionCopy(text) {
  return UNSAFE_CLINICAL_CLAIM.test(String(text || "").normalize("NFKC"));
}

// Use a common check for reactive pricing graphics, follow-up promotion copy
// and delayed price reminders so another path cannot silently bypass a hold.
function promotionHasUnsafeClinicalCopy(value) {
  if (!value || typeof value !== "object") return false;
  const translations = Object.values(value.mediaTranslations || {});
  const followUpTranslations = Object.values(value.followUpTranslations || {});
  const copy = [
    value.caption, value.followUpMessage,
    ...translations.map(item => typeof item === "string" ? item : item?.caption),
    ...followUpTranslations.map(item => typeof item === "string" ? item : item?.message),
  ];
  return copy.some(hasUnsafeClinicalPromotionCopy) ||
    (Array.isArray(value.packages) &&
      value.packages.some(promotionHasUnsafeClinicalCopy));
}

module.exports = {
  hasUnsafeClinicalPromotionCopy,
  promotionHasUnsafeClinicalCopy,
};
