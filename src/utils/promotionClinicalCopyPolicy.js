"use strict";

// Conservative automatic-send guard for explicitly unsafe claims appearing in
// configured promotional captions or follow-up copy. Image pixels and video
// frames cannot be validated by this text-only check and still need review.
const UNSAFE_CLINICAL_CLAIM =
  /(?:90\s*%[^,，.。!！?？;；\n]{0,75}(?:collagen|胶原蛋白|膠原蛋白)|(?:collagen|胶原蛋白|膠原蛋白)[^,，.。!！?？;；\n]{0,75}90\s*%|无副作用|無副作用|no\s+side\s+effects|without\s+(?:any\s+)?side\s+effects|无疼痛感|無疼痛感|(?:完全|绝对|絕對|100\s*%)\s*(?:无痛|無痛)|guaranteed\s+(?:result|outcome|cure|effect)|(?:颅骨|顱骨|头骨|頭骨)\s*(?:骨缝|骨縫).{0,24}(?:变小|變小|缩小|縮小))/iu;

// A sentence like "we cannot guarantee no side effects" is the opposite of
// the guarantee we are trying to prevent. Check the grammar close to each
// unsafe phrase, without allowing a disclaimer elsewhere in the caption to
// excuse an unsafe promise in another clause.
const EN_NEGATED_PROMISE =
  /\b(?:cannot|can't|can not|couldn't|do not|don't|never|unable to|not able to|will not|won't)\b.{0,24}\b(?:guarantee|promise|assure|claim)\b|\b(?:no|not)\s+(?:guarantee|promise)\b/giu;
const ZH_NEGATED_PROMISE =
  /(?:不能|无法|無法|不會|不会|不|没法|沒有辦法|没有办法)\s*(?:保证|保證|承诺|承諾|确保|確保|代表|意味著|意味着)/gu;
const CONTRAST = /(?:\b(?:but|however|yet|instead|although)\b|(?:但|但是|不过|不過|然而|却|卻))/iu;

function isNegatedRiskClaim(source, matchIndex) {
  // A punctuation boundary stops a disclaimer from blessing later claims.
  const before = source.slice(Math.max(0, matchIndex - 100), matchIndex);
  const clauses = before.split(/[。！!？?；;\n，,]|\.\s+/u);
  const clause = clauses.at(-1) || "";
  if (/\bnot\s*$/iu.test(clause)) return true; // "not guaranteed results"
  const negations = [
    ...clause.matchAll(EN_NEGATED_PROMISE),
    ...clause.matchAll(ZH_NEGATED_PROMISE),
  ].sort((a, b) => a.index - b.index);
  const last = negations.at(-1);
  if (!last) return false;
  const afterNegation = clause.slice(last.index + last[0].length);
  return afterNegation.length <= 40 && !CONTRAST.test(afterNegation);
}

function hasUnsafeClinicalPromotionCopy(text) {
  const source = String(text || "").normalize("NFKC");
  const matches = source.matchAll(new RegExp(UNSAFE_CLINICAL_CLAIM.source, "giu"));
  for (const match of matches) {
    if (!isNegatedRiskClaim(source, match.index)) return true;
  }
  return false;
}

// Admin-authored captions/artwork are explicit clinic content choices. Keep
// optional clinical-copy detection available for audits or UI advisories, but
// DO NOT use it as an automatic send-time veto. The independently configured
// Pause switch is the only promotion-content pause; customer intent, consent,
// pricing verification, duplicate checks and Meta rules are enforced separately.
function isPromotionManuallyPaused(value) {
  return value?.automaticMediaHold === true;
}

// Use a common check for reactive pricing graphics, follow-up promotion copy
// and delayed price reminders so another path cannot silently bypass a hold.
function promotionHasUnsafeClinicalCopy(value) {
  if (!value || typeof value !== "object") return false;
  // The historically named automaticMediaHold is a campaign-level pause:
  // artwork text cannot be checked here, so prohibit both automatic graphics
  // and promotion-specific automated follow-up *text* while the hold is set.
  // Independently verified prices in direct customer replies remain available.
  // General, non-promotion follow-ups are governed by their own settings.
  if (isPromotionManuallyPaused(value)) return true;
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
  isPromotionManuallyPaused,
};
