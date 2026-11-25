"use strict";
// Only provider-verified customer text may set sender-specific follow-up context.
// This never grants marketing consent or bypasses a follow-up's normal eligibility.
const {resolveFollowUpTreatment,isBarePostpartumConcernAnswer}=require("./whatsappSecondaryFollowUpLanguage");

// A clear withdrawal pauses reminders even when the customer does not repeat
// a treatment name. Do not interpret questions such as "I don't know how" or
// "不是很清楚" as a refusal.
// A clear distance objection pauses sales reminders without opting out of
// customer-requested replies. Travel-distance questions are not objections.
const DISTANCE_OBJECTION=/^(?:(?:太|很|好)(?:远|遠)(?:了|啦|咯|啊)?|(?:(?:it(?:'s| is)|that(?:'s| is))\s+)?too\s+far(?:\s+(?:away|for\s+me))?|terlalu\s+jauh|jauh\s+(?:sangat|lah|la))[。.!！\s😊🙏]*$/iu;
const DISTANCE_OBJECTION_SQL=String.raw`^(?:(太|很|好)(远|遠)(了|啦|咯|啊)?|((it.s|it is|that.s|that is)[[:space:]]+)?too[[:space:]]+far([[:space:]]+(away|for[[:space:]]+me))?|terlalu[[:space:]]+jauh|jauh[[:space:]]+(sangat|lah|la))[[:space:]。.!！😊🙏]*$`;
const WITHDRAWN=[
 /算了.{0,20}(?:不要|不做|不考虑|不考慮|不用)/iu,
 /(?:^|[，,。!！\s])(?:暂时|暫時)?(?:不要了|不用了|不需要了|不做了|不考虑了|不考慮了)(?:[。!！\s😊🙏]*$)/iu,
 /(?:没兴趣|沒興趣|不感兴趣|不感興趣|不想(?:做|考虑|考慮)|不想要(?:这个|這個|骨盆|3\s*d|9\s*d|疗程|療程|护理|護理)|不要(?:做|安排)(?:这个|這個)?|不要\s*(?:骨盆|3\s*d|9\s*d|小颜|小顏|脉冲|脈衝)|\b(?:not interested|no longer interested|don't want (?:it|this|the treatment)|do not want (?:it|this|the treatment)|(?:don't|do not)\s+want\s+(?:(?:the|this|that|any|a|my)\s+)?(?:pelvic|pelvis|3\s*d|9\s*d|facial|posture|treatment|rawatan|session|therapy|care)\b|rather not|not for me|tak berminat|tak nak|tak mahu|tidak berminat)\b)/iu,
];
// Do not create new reminders after a polite decision to contact us later.
// A question or an explicit new request is not a deferral.
const POLITE_FUTURE_BOOKING=/(?:有需要(?:我)?(?:再|就)(?:预约|預約|联系|聯繫|找你|通知)|(?:之后|之後|下次|下回)(?:有需要)?再(?:来|來|安排|预约|預約)|(?:我|让|讓)?先(?:解决|解決).{0,30}(?:之后|之後|再来|再來)|(?:我)?(?:再)?考虑考虑|(?:我)?(?:再)?考慮考慮|(?:i(?:'ll| will)?|we(?:'ll| will)?)\s*(?:book|contact|reach out)\s*(?:when|if)\s*(?:needed|ready|later)|(?:let me decide later))/iu;
const REMOTE_JOHOR_STATEMENT=/^(?:(?:哦|噢|啊|sorry|不好意思|oh)[，,\s]*)?(?:我(?:是|在|住在)?|i(?:'m| am)\s+(?:in|from)\s+)?(?:jb|johor(?:\s+bahru)?|新山|柔佛|penang|槟城|檳城)(?:的|哦|啊|呢|啦|咯|呀|了)?[。.!！\s😊🙏]*$/iu;
const POLITE_REMOTE_CLOSING=/^(?:(?:哦|噢|啊|嗯|sorry|不好意思|oh|ok|谢谢(?:你)?|謝謝(?:你)?|thank\s+you|thanks|tq|terima\s+kasih)[，,、.!！。\s😊🙏]*){1,5}(?:我(?:是|在|住在)?|i(?:'m| am)\s+(?:in|from)\s+)?(?:jb|johor(?:\s+bahru)?|新山|柔佛|penang|槟城|檳城)(?:的|哦|啊|呢|啦|咯|呀|了)?[。.!！\s😊🙏]*$/iu;
function customerPolitelyDeferred(value) {
  // Location alone is not opt-out: do not suppress a price, service or
  // scheduling question just because a customer happens to live in JB.
  const currentQuestion=/(?:多少钱|多少錢|几多钱|幾多錢|价[格钱錢]|價錢|收费|收費|费用|費用|\b(?:price|cost|fee|how\s+much|harga|berapa)\b|你们有|你們有|可以安排|能预约|能預約|我要预约|我要預約|\b(?:can\s+i\s+book|do\s+you\s+have|can\s+you\s+explain)\b)/iu.test(value);
  const deferCare=/先(?:解决|解決).{0,35}(?:之后|之後).{0,20}再(?:来|來)/u.test(value);
  if(deferCare && !currentQuestion && !/(?:今天|明天|today|tomorrow)/iu.test(value))return true;
  if(currentQuestion || /[?？]/u.test(value))return false;
  return POLITE_FUTURE_BOOKING.test(value) ||
    REMOTE_JOHOR_STATEMENT.test(value) || POLITE_REMOTE_CLOSING.test(value);
}
const DEFERRED=/(?:^(?:我|让我|讓我|先|暂时|暫時)?(?:再)?(?:考虑|考慮)(?:一下|看看|下|先)?[吧哦啊。.!！\s😊]*$|^(?:我再|我会再|我會再|迟点|遲點|过后|過後|之后|之後)(?:联系|聯繫|找|告诉|告訴|回复|回覆|通知)你|(?:let me (?:think|consider)|i(?:'ll| will) (?:let you know|get back(?: to you)?|contact you)|saya (?:akan )?(?:hubungi|beritahu) (?:nanti|kemudian)))/iu;

// A customer may reject one treatment and select another in the SAME turn.
// Only an affirmative clause AFTER the rejection can replace the previous
// treatment. Never interpret an either/or comparison as a selection.
function explicitSwitchChoice(value,clinicConfig){
 const separator=/(?:[,，;；。]|但是|不過|不过|可是|而是|(?:\bbut\b)|(?:\binstead\b))/giu;
 const affirmative=/^(?:我(?:现在|現在|更)?(?:想(?:了解|做|试|試)|要(?:了解|做)?|对|對|考虑|考慮)|(?:现在|現在)?(?:改成|换成|換成)|i(?:'m| am) interested in|i (?:want|prefer)|i(?:'d| would) (?:like|prefer)|saya (?:nak|mahu|berminat)|(?:3\s*d|9\s*d).{0,35}\b(?:looks good|sounds good|is better)\b)/iu;
 for(const match of value.matchAll(separator)){
   const phrase=value.slice(match.index+match[0].length).trim();
   if(!affirmative.test(phrase) || WITHDRAWN.some(re=>re.test(phrase)) ||
       DEFERRED.test(phrase))continue;
   const chosen=resolveFollowUpTreatment({clinicConfig,customerTexts:[phrase]});
   if(chosen)return chosen;
 }
 return null;
}
function classifyVerifiedTreatmentTurn({text,clinicConfig}={}){
 const value=String(text||"").normalize("NFKC").trim();
 if(!value || value.length>1500)return null;
 // A customer selecting Other is explicitly reopening treatment choice.
 if(value==="其他护理")return {status:"ambiguous",treatment:null};
 if(WITHDRAWN.some(pattern=>pattern.test(value))){
   const replacement=explicitSwitchChoice(value,clinicConfig);
   if(replacement)return {status:"selected",treatment:replacement};
   return {status:"declined",treatment:null};
 }
 if(DISTANCE_OBJECTION.test(value) || DEFERRED.test(value) || customerPolitelyDeferred(value))
   return {status:"deferred",treatment:null};
 // "产后" by itself describes a concern, not a verified switch to the
 // separately named postpartum treatment. Keep the earlier signed choice.
 if(isBarePostpartumConcernAnswer(value))return null;
 const service=resolveFollowUpTreatment({clinicConfig,customerTexts:[value]});
 if(service)return {status:"selected",treatment:service};
 // A comparison between distinct treatments is evidence that the older choice
 // is no longer safely established. Preserve ambiguity without guessing.
 const has3d=/3\s*d/iu.test(value),has9d=/9\s*d/iu.test(value);
 const bothConfigured=(clinicConfig?.services||[]).some(s=>/3\s*d/iu.test(s?.name||"")) &&
   (clinicConfig?.services||[]).some(s=>/9\s*d/iu.test(s?.name||""));
 if(has3d && has9d && bothConfigured)
   return {status:"ambiguous",treatment:null};
 return null;
}
// Old data may already have stored 产后调理 from a bare answer even when
// the customer explicitly chose pelvic care before it. Do not send a
// treatment-specific reminder off that suspect historical classification.
// This fails closed to a general message until the signed state is repaired.
function isSuspectStoredPostpartumChoice({customerTexts,storedTreatment,clinicConfig}={}) {
 if(storedTreatment!=="产后调理")return false;
 const texts=Array.isArray(customerTexts)?customerTexts:[];
 if(!texts.some(isBarePostpartumConcernAnswer))return false;
 const explicitPostpartum=texts.some(value=>
   !isBarePostpartumConcernAnswer(value) &&
   classifyVerifiedTreatmentTurn({text:value,clinicConfig})?.treatment==="产后调理");
 if(explicitPostpartum)return false;
 return texts.some(value=>
   classifyVerifiedTreatmentTurn({text:value,clinicConfig})?.treatment==="骨盆调理");
}
function isStoppedDecision(status){
 return status==="declined" || status==="deferred";
}

// Resolve the newest meaningful decision after the latest explicit reset.
function recoveryTopicDecision(customerTexts,clinicConfig) {
 const texts=Array.isArray(customerTexts)?customerTexts:[];
 const reset=texts.findIndex(value=>String(value||"").normalize("NFKC").trim()==="其他护理");
 if(reset<0)return null;
 for(const value of texts.slice(0,reset)){
   const decision=classifyVerifiedTreatmentTurn({text:value,clinicConfig});
   if(decision)return decision;
 }
 return {status:"ambiguous",treatment:null};
}

// Always rank the newest verified customer choice ahead of older CRM fields
// and Meta ad creatives. Keep the same choice for the text, video and 20h AI.
function chooseSecondaryFollowUpTreatment({
 candidate={},clinicConfig,adFollowUpPolicy=null,latestDecision=null,
}={}){
 const services=(clinicConfig?.services||[]).map(x=>x?.name).filter(Boolean);
 const resetDecision=recoveryTopicDecision(candidate.customer_texts,clinicConfig);
 if(resetDecision){
   const valid=resetDecision.status==="selected" && services.includes(resetDecision.treatment);
   return {treatment:valid?resetDecision.treatment:null,generalOnly:!valid,customerSelected:valid};
 }
 if(latestDecision?.status!=="selected" && isSuspectStoredPostpartumChoice({
  customerTexts:candidate.customer_texts,
  storedTreatment:candidate.verified_treatment_name,
  clinicConfig,
 }))return{treatment:null,generalOnly:true,customerSelected:false};
 // New uncertainty overrides a prior selection even before its async state
 // write finishes. Never send media for an unresolved either/or question.
 if(latestDecision?.status==="ambiguous")
   return{treatment:null,generalOnly:true,customerSelected:false};
 // A bare postpartum response does not authorize an ad/CRM fallback to
 // an unrelated treatment. A previously signed pelvic choice may continue.
 if(isBarePostpartumConcernAnswer(candidate.customer_texts?.[0]) &&
    !(candidate.verified_treatment_status==="selected" &&
      candidate.verified_treatment_name==="骨盆调理"))
   return {treatment:null,generalOnly:true,customerSelected:false};
 const selectedLatest=latestDecision?.status==="selected" ? latestDecision.treatment : null;
 const selectedStored=candidate.verified_treatment_status==="selected"
   ? candidate.verified_treatment_name : null;
 const customerChoice=selectedLatest||selectedStored;
 if(customerChoice){
   const valid=services.includes(customerChoice);
   return{treatment:valid?customerChoice:null,generalOnly:!valid,
     customerSelected:valid};
 }
 if(latestDecision?.status==="ambiguous" ||
    candidate.verified_treatment_status==="ambiguous" ||
    adFollowUpPolicy?.ambiguous===true)
   return{treatment:null,generalOnly:true,customerSelected:false};
 if(adFollowUpPolicy?.treatment)
   return{treatment:services.includes(adFollowUpPolicy.treatment)
     ? adFollowUpPolicy.treatment:null,
     generalOnly:!services.includes(adFollowUpPolicy.treatment),
     customerSelected:false};
 return{treatment:resolveFollowUpTreatment({
   clinicConfig,customerTexts:candidate.customer_texts,
   treatmentInterest:candidate.treatment_interest,
 }),generalOnly:false,customerSelected:false};
}
// Marketing must not rely on a lagging database snapshot when the latest
// sender-owned customer message explicitly chooses a different treatment.
function latestMarketingIntentMatches({customerMessages,treatmentInterest,clinicConfig}={}){
 if(isSuspectStoredPostpartumChoice({
  customerTexts:customerMessages,storedTreatment:treatmentInterest,clinicConfig,
 }))return false;
 const latestText=Array.isArray(customerMessages)?customerMessages[0]:null;
 if(isBarePostpartumConcernAnswer(latestText) &&
    treatmentInterest!=="骨盆调理") return false;
 const resetDecision=recoveryTopicDecision(customerMessages,clinicConfig);
 if(resetDecision)return resetDecision.status==="selected" && resetDecision.treatment===treatmentInterest;
 const latest=classifyVerifiedTreatmentTurn({
   text:latestText,
   clinicConfig,
 });
 return !latest || (latest.status==="selected" && latest.treatment===treatmentInterest);
}
module.exports={classifyVerifiedTreatmentTurn,isStoppedDecision,
 chooseSecondaryFollowUpTreatment,latestMarketingIntentMatches,recoveryTopicDecision,WITHDRAWN,DEFERRED,
  customerPolitelyDeferred,
 DISTANCE_OBJECTION,DISTANCE_OBJECTION_SQL};
