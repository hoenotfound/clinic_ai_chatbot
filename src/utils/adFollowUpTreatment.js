"use strict";

const { matchingMetaAdCreativeServices, resolveMetaAdCreativeService } =
  require("../services/metaAdReplyContextService");

// Only actual Meta creative and current customer words may select the treatment.
// A scored CRM label or an ad name alone can never resolve an ad promoting
// both 3D and 9D. Customer messages are ordered NEWEST first.
const CUSTOMER_DECLINE = /(?:don't|do not|not interested|no longer|rather not|不要|不想|不是|没兴趣|沒興趣|tak nak|tak mahu)/iu;
const COMPARISON = /(?:\b(?:or|vs|versus|either|compare|difference|which one)\b|还是|還是|或者|比较|比較|区别|區別|哪一个|哪個|atau|beza)/iu;

function resolveAdFollowUpTreatment({
  adSource = null, headline = null, body = null,
  customerTexts = [], services = [], serviceAliases = [],
} = {}) {
  if (adSource !== "meta_ads") return null;
  const creative = {headline,body};
  const creativeMatches = matchingMetaAdCreativeServices(creative,services,serviceAliases);
  const creativeService = resolveMetaAdCreativeService(creative,services,serviceAliases);
  for (const original of Array.isArray(customerTexts) ? customerTexts : []) {
    const text = String(original || "").normalize("NFKC").trim();
    if (!text) continue;
    const named = matchingMetaAdCreativeServices(
      {headline:null,body:text},services,serviceAliases);
    if (!named.length) continue;
    // Rejection, an either/or question or multiple services in one customer
    // message must never turn an ambiguous ad into one specific treatment.
    if (CUSTOMER_DECLINE.test(text) || COMPARISON.test(text)) {
      return {ambiguous:true,treatment:null,source:"customer_ambiguous"};
    }
    const specific = named.length === 1
      ? named[0] : resolveMetaAdCreativeService(
        {headline:null,body:text},services,serviceAliases);
    if (!specific || !named.includes(specific)) {
      return {ambiguous:true,treatment:null,source:"customer_ambiguous"};
    }
    return {ambiguous:false,treatment:specific,source:"customer_selection"};
  }
  // One proven treatment in the *creative* can be carried forward after a
  // nonspecific "PM" enquiry. If creative has multiple/zero treatments the
  // follow-up must remain general, regardless of stale CRM interest.
  if (creativeService && creativeMatches.includes(creativeService))
    return {ambiguous:false,treatment:creativeService,source:"verified_ad_creative"};
  return {ambiguous:true,treatment:null,source:"ad_creative_unverified_or_multiple"};
}

module.exports = {resolveAdFollowUpTreatment};
