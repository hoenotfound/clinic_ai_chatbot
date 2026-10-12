"use strict";

// Plain-language refusals are independent of a customer's wish to learn
// about a treatment. Reuse this evidence for both immediate STOP handling
// and price/media eligibility so "No promotions please" cannot unlock promos.
const ENGLISH_MARKETING_REFUSAL =
  /\b(?:no(?:\s+more)?|skip|avoid|without)\s+(?:any\s+)?(?:more\s+)?(?:promotions?|promos?|offers?|discounts?|deals?|marketing(?:\s+messages?)?)\b(?=\s*(?:$|[,;.?!]|please\b|thanks?\b|thank\s+you\b|for\s+me\b|just\b))|\b(?:stop|don['’]?t|do\s+not|never|not\s+interested\s+in)\s+(?:(?:sending?|send|show|want|need|give)\s+(?:me\s+)?)?(?:any\s+)?(?:promotions?|promos?|offers?|discounts?|deals?|marketing(?:\s+messages?)?)\b/giu;

function hasExplicitMarketingRefusal(value) {
  return String(value || "").search(ENGLISH_MARKETING_REFUSAL) !== -1;
}

function withoutExplicitMarketingRefusal(value) {
  return String(value || "").replace(ENGLISH_MARKETING_REFUSAL, " ");
}

module.exports = {
  hasExplicitMarketingRefusal,
  withoutExplicitMarketingRefusal,
};
