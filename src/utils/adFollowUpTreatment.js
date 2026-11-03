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
      return {ambiguous:true,treatment:null,source:"customer_ambiguous",creativeMatches};
    }
    const specific = named.length === 1
      ? named[0] : resolveMetaAdCreativeService(
        {headline:null,body:text},services,serviceAliases);
    if (!specific || !named.includes(specific)) {
      return {ambiguous:true,treatment:null,source:"customer_ambiguous",creativeMatches};
    }
    return {ambiguous:false,treatment:specific,source:"customer_selection",creativeMatches};
  }
  // One proven treatment in the *creative* can be carried forward after a
  // nonspecific "PM" enquiry. If creative has multiple/zero treatments the
  // follow-up must remain general, regardless of stale CRM interest.
  if (creativeService && creativeMatches.includes(creativeService))
    return {ambiguous:false,treatment:creativeService,source:"verified_ad_creative",creativeMatches};
  return {ambiguous:true,treatment:null,source:"ad_creative_unverified_or_multiple",creativeMatches};
}


// For an unresolved ad advertising both 3D and 9D, do not insert either
// treatment into the follow-up until the customer actually chooses one.
function neutralMixedAdFollowUp({policy,language="en",slot=2}={}) {
  if (!policy?.ambiguous || Number(slot) !== 2) return null;
  const choices=Array.isArray(policy.creativeMatches)?policy.creativeMatches:[];
  const includes3d=choices.some(s=>/3\s*d/i.test(s)&&!/9\s*d/i.test(s));
  const includes9d=choices.some(s=>/9\s*d/i.test(s)&&!/3\s*d/i.test(s));
  if (!includes3d || !includes9d) return null;
  if (language==="zh") return "想了解哪一种小颜护理呢？3D 主要针对脸型轮廓，9D 侧重紧致提升 😊 你比较关心哪一项？";
  if (language==="ms") return "Nak tahu lebih lanjut tentang yang mana satu? 3D lebih kepada bentuk muka, manakala 9D fokus pada penegangan 😊";
  return "Would you like to know more about 3D facial contouring or 9D skin tightening? I can explain either one 😊";
}

module.exports = {resolveAdFollowUpTreatment,neutralMixedAdFollowUp};
