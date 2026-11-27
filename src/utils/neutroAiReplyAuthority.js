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
// Keep the existing AI-led action and review policy independent of the
// conversational rewrite rollout. Legacy means the current deployed behavior,
// not disabling verified pricing, appointment or sales state safeguards.
function resolveAiReplyAuthorityMode(config) {
  if (!usesNaturalReplyAuthority(config)) return "legacy";
  return ["observe","enabled"].includes(config.aiReplyAuthorityMode)
    ? config.aiReplyAuthorityMode : "legacy";
}
// Only explicitly classified optional rewrites use this boundary. Never call
// it for factual correction, safety, consent, language or action validation.
const OPTIONAL_CONVERSATIONAL_REWRITES=new Set([
  "unapprovedPriceClarification","improveRepeatedPriceClarification",
  "rejectedModelPricingClarification","optionalComboUpsell",
]);
function suppressConversationalRewrite(config,audit,reason) {
  if(!OPTIONAL_CONVERSATIONAL_REWRITES.has(reason))return false;
  const mode=resolveAiReplyAuthorityMode(config);
  if(mode==="legacy") return false;
  if(mode==="observe") audit?.suppressed?.(reason);
  return true;
}
// Use only after a new review has actually been persisted.
function recordedReviewAcknowledgement(category, language="zh") {
  const lang=String(language).toLowerCase().slice(0,2);
  if(category==="clinical")return lang==="en"?"Thank you for sharing. I've recorded your question for our practitioner to review. We can't determine suitability through chat.":lang==="ms"?"Terima kasih atas maklumat tersebut. Soalan anda telah direkodkan untuk semakan pengamal. Kesesuaian tidak dapat ditentukan melalui chat.":"谢谢您告诉我们哦，您的问题已记录并交由中医师进一步评估，是否适合护理需要专业确认。";
  return lang==="en"?"I've recorded your question for our centre to check 😊":lang==="ms"?"Soalan anda telah direkodkan untuk pihak pusat semak 😊":"您的问题已记录，让门店同事帮您确认一下哦 😊";
}
// Only a genuinely completed social turn permits an ambiguous "OK" or
// smile. A bare factual answer, active question, slot or payment is not closure.
function explicitSocialClosing(value){
  const text=String(value||"").trim();
  if(!text||/[?？]/u.test(text)||
    /(?:请问|請問|方便吗|方便嗎|想不想|要不要|是否|几时|幾時|几点|幾點|which|what|when|would you|can you|do you|boleh tak|bila|berapa)/iu.test(text)||
    /(?:\b(?:payment|deposit|confirm(?:ed)?|slot)\b|付款|订金|訂金|押金|已确认|已確認|\d{1,2}\s*(?:am|pm)|\d{1,2}[:：]\d{2}|\d{1,2}[/-]\d{1,2})/iu.test(text))return false;
  return /(?:祝(?:你|您)|祝福|随时(?:再)?(?:联系|找|欢迎)|隨時(?:再)?(?:聯繫|找|歡迎)|随时欢迎|隨時歡迎|有(?:过|過)来随时|有(?:过|過)來隨時|welcome (?:back|anytime)|have a (?:nice|good|great|lovely) day|take care|feel free to (?:contact|reach out|message)|selamat maju jaya|hubungi kami bila-bila)/iu.test(text);
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
  const last=turns.at(-1);
  // No-reply deliberately leaves no assistant row. A second social
  // acknowledgement may follow the first one; look back through at most
  // two such user turns, never through a substantive enquiry.
  let priorIndex=turns.length-2;
  const closingAck=value=>/^(?:ok(?:ay)?|baik|好的?|嗯|thanks|thank you|谢谢|謝謝|[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F\u200D\s]+)[.!。！\s]*$/iu.test(String(value||"").trim());
  while(priorIndex>=0&&turns.length-2-priorIndex<2&&turns[priorIndex]?.role==="user"&&closingAck(turns[priorIndex].content))priorIndex--;
  const previous=turns[priorIndex];
  if(last?.role!=="user"||String(last.content||"").trim()!==text||
     previous?.role!=="assistant"||previous.pricingDeliveredBotMessage!==true||
     previous.pricingStaffAuthored===true||/[?？]/u.test(String(previous.content||"")))return false;
  const closing=explicitSocialClosing(previous.content);
  if(priorIndex!==turns.length-2&&!closing)return false;
  // A broad emoji/OK is safe only after a verified, explicit social ending.
  // Preserve the older strict acceptance boundary for all other turns.
  // Even without a question mark a prior scheduling or payment invitation
  // may make an emoji an acceptance rather than a social closing.
  if (/(?:预约|預約|安排|确认空档|確認空檔|付款|订金|訂金|押金|\b(?:book(?:ing)?|appointment|slot|payment|deposit|temujanji|janji temu|bayaran)\b)/iu.test(String(previous.content||"")))return false;
  if(closing && closingAck(text))return true;
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
// Late recovery is text-only. Keep the actual state transition centralized
// and require affirmative evidence; pending or unknown is never clearance.
function routineReviewTextOnlyState(evidence,reply){
  if(evidence?.pendingClinicalReview!==false||typeof reply!=="string"||!reply.trim())return null;
  return {reply,flagged:false,reviewRequired:false,reviewType:null,bookingReady:false,
    serviceQuery:false,serviceQuerySource:null,priceQuery:false,packageQuery:false,
    details:null,clinicalAcknowledgement:null,reviewContinuationTextOnly:true};
}
function createReplyOverrideAudit(log=console.info) {
  const reasons=new Set(), suppressed=new Set();
  return {
    suppressed(reason){suppressed.add(reason);},
    change(reason,before,after){if(typeof before==="string"&&typeof after==="string"&&before!==after)reasons.add(reason);return after;},
    note(reason){reasons.add(reason);},
    flush({contactId,inboundId,original,final,outcome}={}){
      const changed=typeof original==="string"&&typeof final==="string"?original!==final:null;
      if(!reasons.size&&!suppressed.size&&!changed)return;
      if(!reasons.size&&changed)reasons.add("unattributed");
      log("[Reply authority] "+JSON.stringify({contactId,inboundId,reasons:[...reasons],...(suppressed.size?{suppressed:[...suppressed]}:{}),changed,outcome}));
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
// Model intent changes sales eligibility only. It cannot change consent,
 // ownership, appointments or delivery permission. Source evidence is the
 // exact current inbound, and reopened interest must be a real new enquiry.
function salesFollowUpIntent({config,parsed,customerText,keywordReason,urgentSafety,marketingStopQuestion,verifiedReopen=false}={}){
  if(!usesNaturalReplyAuthority(config)||parsed?.structured!==true||parsed.flagged||
    parsed.reviewRequired||parsed.languageCorrectionFailed||
    !["normal","no_reply"].includes(parsed.outcome)||keywordReason||urgentSafety||marketingStopQuestion)return null;
  const text=String(customerText||"").trim();
  const intent=parsed.details?.salesFollowUpIntent;
  if(!text||text.length>500||parsed.details?.salesFollowUpEvidence!==text||
    hasClinicalMediaRisk(text)||isActiveSafetyConcern(text)||isExplicitStaffRequest(text)||
    isDefiniteAppointmentCancellation(text)||detectExplicitLanguagePreference(text))return null;
  if(intent==="declined"||intent==="deferred"){
    if(parsed.serviceQuery||parsed.priceQuery||parsed.packageQuery||parsed.bookingReady||
      parsed.details?.appointmentScheduling||/[?？]/u.test(text))return null;
    // Acknowledgements are not independent evidence of a decline.
    if(/^(?:ok(?:ay)?|yes|no|can|sure|thanks|thank you|好的?|嗯|可以|谢谢|謝謝|boleh|baik|ya|[\p{Extended_Pictographic}\uFE0F\u200D\s]+)[.!。！\s]*$/iu.test(text))return null;
    return intent;
  }
  if(intent==="reopened"&&verifiedReopen&&(parsed.serviceQuery||parsed.priceQuery||parsed.packageQuery))return intent;
  return null;
}
const SALES_STATE_INSERT_SQL=`
  INSERT INTO lead_activities(lead_id,activity_type,description,actor,metadata)
  SELECT lead.id,'updated','Customer sales follow-up preference recorded.','Automation',
    jsonb_build_object('outcome','customer_sales_followup_state','inboundMessageId',inbound.id,'state',$4::text)
  FROM messages inbound
  JOIN LATERAL (SELECT l.id,l.created_at FROM leads l WHERE l.contact_id=inbound.contact_id
    AND l.is_closed=false ORDER BY l.created_at DESC,l.id DESC LIMIT 1) lead ON true
  WHERE inbound.id=$2 AND inbound.contact_id=$1 AND inbound.role='user'
    AND BTRIM(inbound.content)=BTRIM($3)
    AND inbound.whatsapp_customer_mutation IS NULL AND inbound.is_forwarded IS DISTINCT FROM TRUE
    AND inbound.created_at>=lead.created_at-INTERVAL '30 minutes'
    AND NOT EXISTS(SELECT 1 FROM lead_activities existing WHERE existing.lead_id=lead.id
      AND existing.metadata->>'outcome'='customer_sales_followup_state' AND existing.metadata->>'inboundMessageId'=inbound.id::text)
    AND $4::text IN ('declined','deferred','reopened')
  RETURNING id`;
async function persistSalesFollowUpIntent({contactId,inboundId,customerText,intent,database}={}){
  if(!["declined","deferred","reopened"].includes(intent)||
    ![contactId,inboundId].every(id=>Number.isSafeInteger(Number(id))&&Number(id)>0))return false;
  const db=database||require("../db/db").pool;
  const client=await db.connect();
  try{
    await client.query("BEGIN");
    await require("../db/conversationLock").lockConversation(client,contactId);
    const result=await client.query(SALES_STATE_INSERT_SQL,[contactId,inboundId,String(customerText).trim(),intent]);
    await client.query("COMMIT");
    return Boolean(result.rows?.length);
  }catch(error){
    await client.query("ROLLBACK").catch(()=>{});
    throw error;
  }finally{client.release();}
}
module.exports={resolveAiReplyAuthorityMode,suppressConversationalRewrite,salesFollowUpIntent,persistSalesFollowUpIntent,SALES_STATE_INSERT_SQL,routineReviewTextOnlyState,routineReviewRecoveryEligible,usesNaturalReplyAuthority,recordedReviewAcknowledgement,canHonorNoReply,createReplyOverrideAudit,createClinicalReviewEvidenceReader};
