"use strict";

const clinicConfig=require("./clinicConfig");
const defaults=require("./neutroRm68Campaign.default.json");
const languages=["zh","en","ms"];
const liveStates=["both","dec6"];

function finiteTimestamp(value){
  return typeof value==="string" && Number.isFinite(Date.parse(value));
}
function hasValidCopy(value,active){
  return typeof value==="string" && value.trim().length>0 && value.length<=3000 &&
    (active ? /\bRM\s*68\b/iu.test(value) &&
      [...value.matchAll(/\b(?:RM|MYR)\s*(\d+(?:\.\d+)?)/giu)].every(m=>Number(m[1])===defaults.priceMYR)
      : !/\b(?:RM|MYR)\s*\d/iu.test(value));
}
// This is a versioned historical offer, not a generic campaign editor.
// Changing dates, price, package or identity requires a new campaign ID.
// A configured expiry can stop the offer early, but never extend it.
function validRm68CampaignSettings(value){
  if(!value || typeof value!=="object" || Array.isArray(value) ||
    value.version!==defaults.version || value.campaignKey!==defaults.campaignKey ||
    value.timezone!==defaults.timezone ||
    JSON.stringify(value.eventDates)!==JSON.stringify(defaults.eventDates) ||
    value.lastDayStartsAt!==defaults.lastDayStartsAt ||
    value.priceMYR!==defaults.priceMYR || value.careMinutes!==defaults.careMinutes ||
    value.totalMinutes!==defaults.totalMinutes ||
    !finiteTimestamp(value.expiresAt) ||
    Date.parse(value.expiresAt)>Date.parse(defaults.expiresAt))return false;
  return liveStates.every(state=>languages.every(lang=>
    hasValidCopy(value.firstReply?.[state]?.[lang],true) &&
    hasValidCopy(value.followUp?.[state]?.[lang],true))) &&
    languages.every(lang=>hasValidCopy(value.firstReply?.expired?.[lang],false));
}
function rm68CampaignSettings(config=clinicConfig){
  const present=Object.prototype.hasOwnProperty.call(config||{},"neutroRm68Campaign");
  if(!present)return {valid:true,source:"legacy_default",campaign:defaults};
  const campaign=config.neutroRm68Campaign;
  return validRm68CampaignSettings(campaign)
    ? {valid:true,source:"neon",campaign}
    : {valid:false,source:"invalid",campaign:defaults};
}
module.exports={rm68CampaignSettings,validRm68CampaignSettings};
