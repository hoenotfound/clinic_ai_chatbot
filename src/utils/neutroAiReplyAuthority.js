"use strict";
const {hasClinicalMediaRisk}=require("./aiReviewPolicy");
const {isDefiniteAppointmentCancellation}=require("./appointmentCancellationSafety");
const {hasExplicitPriceRequest}=require("./customerEnquiryEvidence");
const {detectExplicitLanguagePreference}=require("./chatLanguage");
const {checkKeywordTriggers,isActiveSafetyConcern,isExplicitStaffRequest}=require("./attentionTriggers");
function usesNaturalReplyAuthority(config) {
  return config?.businessType === "tcm_clinic" &&
    /^neutro\s+sense\b/iu.test(String(config.businessName || config.clinicName || "")) &&
    config.aiPricingIntentMode === "enabled";
}
// Use only after a new review has actually been persisted.
function recordedReviewAcknowledgement(category, language="zh") {
  const lang=String(language).toLowerCase().slice(0,2);
  if(category==="clinical")return lang==="en"?"Thank you for sharing. I've recorded your question for our practitioner to review. We can't determine suitability through chat.":lang==="ms"?"Terima kasih atas maklumat tersebut. Soalan anda telah direkodkan untuk semakan pengamal. Kesesuaian tidak dapat ditentukan melalui chat.":"谢谢您告诉我们哦，您的问题已记录并交由中医师进一步评估，是否适合护理需要专业确认。";
  return lang==="en"?"I've recorded your question for our centre to check 😊":lang==="ms"?"Soalan anda telah direkodkan untuk pihak pusat semak 😊":"您的问题已记录，让门店同事帮您确认一下哦 😊";
}
// The model selects closure. Independent evidence only limits unsafe silence.
function canHonorNoReply({config,parsed,customerText,history=[],contact,isFirstMessage,
  keywordReason,marketingStopQuestion,bookingContext,recoveryPromptProof,urgentSafety}={}){
  if(!usesNaturalReplyAuthority(config)||parsed?.structured!==true||
     parsed.outcome!=="no_reply"||parsed.flagged||parsed.bookingReady||
     parsed.serviceQuery||parsed.priceQuery||parsed.packageQuery||
     parsed.details?.appointmentScheduling||parsed.details?.appointmentProposal||
     parsed.details?.appointmentPreference||parsed.details?.businessLocationOnly||
     isFirstMessage||contact?.needs_attention||keywordReason||marketingStopQuestion||
     urgentSafety||recoveryPromptProof||bookingContext?.appointmentAt||
     /^(?:booked|confirmed|scheduled|pending|booking_ready)$/iu.test(String(bookingContext?.status||"")))return false;
  const text=String(customerText||"").trim();
  if(!text||text.length>80||/[?？]/u.test(text)||
     hasClinicalMediaRisk(text)||isActiveSafetyConcern(text)||isExplicitStaffRequest(text)||
     checkKeywordTriggers(text)||isDefiniteAppointmentCancellation(text)||
     hasExplicitPriceRequest(text)||detectExplicitLanguagePreference(text))return false;
  const turns=Array.isArray(history)?history:[];
  const last=turns.at(-1),previous=turns.at(-2);
  if(last?.role!=="user"||String(last.content||"").trim()!==text||
     previous?.role!=="assistant"||previous.pricingDeliveredBotMessage!==true||
     previous.pricingStaffAuthored===true||/[?？]/u.test(String(previous.content||"")))return false;
  // Even without a question mark a prior scheduling or payment invitation
  // may make an emoji an acceptance rather than a social closing.
  if (/(?:预约|預約|安排|确认空档|確認空檔|付款|订金|訂金|押金|\b(?:book(?:ing)?|appointment|slot|payment|deposit|temujanji|janji temu|bayaran)\b)/iu.test(String(previous.content||"")))return false;
  // Require a short social closing, not arbitrary message content. This is
  // a restrictive safety boundary, never a standalone keyword ignore rule.
  return /^(?:(?:thanks|thank you|terima kasih|谢谢|謝謝|多谢|多謝|tq|thx)(?:\s*(?:very much|so much|很多|您|你|ya))?|[👍👌🙏❤️💚😊☺️\s]+)[.!。！\s]*$/iu.test(text);
}
// One eligibility boundary for late routine review recovery. A positive
// result is NOT clinical clearance or authorization to perform an action.
// Callers still require fresh independent Neon evidence before clearing review.
function routineReviewRecoveryEligible({config,naturalReplyAuthority,flagged,reviewRequired,reviewType,
  keywordReason,urgentSafety,marketingStopQuestion,customerText,bookingReady,channel,
  whatsappOnly=false,informationOnly=false,requireNoBooking=false}={}){
  return Boolean(flagged&&reviewRequired&&
    (!(naturalReplyAuthority||informationOnly)||reviewType==="information")&&
    !keywordReason&&!urgentSafety&&!marketingStopQuestion&&
    !isActiveSafetyConcern(customerText)&&!hasClinicalMediaRisk(customerText)&&
    !isExplicitStaffRequest(customerText)&&!isDefiniteAppointmentCancellation(customerText)&&
    (!(requireNoBooking||naturalReplyAuthority)||!bookingReady)&&
    (!whatsappOnly||channel==="whatsapp")&&
    config?.businessType==="tcm_clinic"&&
    /^neutro\s+sense\b/iu.test(String(config.businessName||config.clinicName||"")));
}
function createReplyOverrideAudit(log=console.info) {
  const reasons=new Set();
  return {
    change(reason,before,after){if(typeof before==="string"&&typeof after==="string"&&before!==after)reasons.add(reason);return after;},
    note(reason){reasons.add(reason);},
    flush({contactId,inboundId,original,final,outcome}={}){
      if(!reasons.size&&!(typeof original==="string"&&typeof final==="string"&&original!==final))return;
      if(!reasons.size)reasons.add("unattributed");
      log("[Reply authority] "+JSON.stringify({contactId,inboundId,reasons:[...reasons],changed:typeof original==="string"&&typeof final==="string"?original!==final:null,outcome}));
    }
  };
}
// Reuse a confirmed clinical-review veto only for this inbound turn.
// Never cache clearance or an unavailable read.
function createClinicalReviewEvidenceReader(read,{reuseVeto=false}={}){
  let pending=null;
  return async()=>{
    if(reuseVeto&&pending)return pending;
    const evidence=await read();
    if(reuseVeto&&evidence?.pendingClinicalReview===true)pending=evidence;
    return evidence;
  };
}
module.exports={routineReviewRecoveryEligible,usesNaturalReplyAuthority,recordedReviewAcknowledgement,canHonorNoReply,createReplyOverrideAudit,createClinicalReviewEvidenceReader};
