"use strict";

const clinicConfig=require("./clinicConfig");
const defaults=require("./neutroRm68Campaign.default.json");
const {campaignDatesInText}=require("../utils/neutroRm68DateEvidence");
const languages=["zh","en","ms"];
const liveStates=["both","dec6"];
 // Existing SQL exclusions and delivered-history recognition intentionally
 // retain these approved markers. Editing them would let an unrelated
 // standard promotion re-enter a campaign conversation.
const firstReplyMarkers={
  zh:["我们目前推出【胸部专业检查 + 脉冲波疏通乳腺护理】","首次体验只需 RM68","全程约 1小时30分钟"],
  en:["Our limited-time breast wellness assessment + gentle pulse wave care offer","First trial: RM68","1 hour 30 minutes"],
  ms:["Promosi terhad penilaian kesejahteraan payudara + penjagaan gelombang denyutan lembut","Percubaan pertama: RM68","1 jam 30 minit"],
};

function finiteTimestamp(value){
  return typeof value==="string" && Number.isFinite(Date.parse(value));
}
function hasValidCopy(value,active,state){
  if(typeof value!=="string" || !value.trim() || value.length>3000)return false;
  const amounts=[...value.normalize("NFKC").matchAll(/(?:\b(?:RM|MYR)\s*|马币\s*|令吉\s*)(\d[\d,]*(?:\.\d+)?)/giu)]
    .map(m=>Number(m[1].replace(/,/g,"")));
  if(!active)return amounts.length===0;
  if(!amounts.length || amounts.some(n=>n!==defaults.priceMYR))return false;
  const dates=campaignDatesInText(value);
  const expected=state==="dec6"?[6]:[5,6];
  if(!dates.length || dates.some(d=>d.month!==12 || !expected.includes(d.day)) ||
    expected.some(day=>!dates.some(d=>d.day===day)))return false;
  if(/\b20(?!26)\d{2}\b/u.test(value))return false;
  // Do not accept a different package duration, a clinical guarantee, or
  // an already-confirmed appointment in operator-configured campaign copy.
  const normalized=value.replace(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|jam|小时|小時)\s*(\d+)\s*(?:minutes?|mins?|minit|分钟|分鐘)/giu,(_,h,m)=>(Number(h)*60+Number(m))+" minutes");
  for(const m of normalized.matchAll(/(\d+(?:\.\d+)?)\s*(hours?|hrs?|jam|小时|小時|minutes?|mins?|minit|分钟|分鐘)/giu)){
    const mins=/^(?:hours?|hrs?|jam|小时|小時)$/iu.test(m[2])?Number(m[1])*60:Number(m[1]);
    if(![defaults.careMinutes,defaults.totalMinutes].includes(mins))return false;
  }
  return !/(?:保证治愈|保證治癒|保证有效|保證有效|已预约成功|已預約成功|\b(?:guaranteed cure|guaranteed results|your (?:booking|appointment) is confirmed|we have booked you|dijamin sembuh|temu janji anda telah disahkan)\b)/iu.test(value);
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
    hasValidCopy(value.firstReply?.[state]?.[lang],true,state) &&
    firstReplyMarkers[lang].every(marker=>value.firstReply[state][lang].includes(marker)) &&
    hasValidCopy(value.followUp?.[state]?.[lang],true,state))) &&
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
