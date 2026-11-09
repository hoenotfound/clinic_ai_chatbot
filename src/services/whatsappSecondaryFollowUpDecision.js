"use strict";
// Only provider-verified customer text may set sender-specific follow-up context.
// This never grants marketing consent or bypasses a follow-up's normal eligibility.
const {resolveFollowUpTreatment}=require("./whatsappSecondaryFollowUpLanguage");

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
 if(WITHDRAWN.some(pattern=>pattern.test(value))){
   const replacement=explicitSwitchChoice(value,clinicConfig);
   if(replacement)return {status:"selected",treatment:replacement};
   return {status:"declined",treatment:null};
 }
 if(DISTANCE_OBJECTION.test(value) || DEFERRED.test(value))
   return {status:"deferred",treatment:null};
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
function isStoppedDecision(status){
 return status==="declined" || status==="deferred";
}

// Always rank the newest verified customer choice ahead of older CRM fields
// and Meta ad creatives. Keep the same choice for the text, video and 20h AI.
function chooseSecondaryFollowUpTreatment({
 candidate={},clinicConfig,adFollowUpPolicy=null,latestDecision=null,
}={}){
 const services=(clinicConfig?.services||[]).map(x=>x?.name).filter(Boolean);
 // New uncertainty overrides a prior selection even before its async state
 // write finishes. Never send media for an unresolved either/or question.
 if(latestDecision?.status==="ambiguous")
   return{treatment:null,generalOnly:true,customerSelected:false};
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
 const latest=classifyVerifiedTreatmentTurn({
   text:Array.isArray(customerMessages)?customerMessages[0]:null,
   clinicConfig,
 });
 return !latest || (latest.status==="selected" && latest.treatment===treatmentInterest);
}
module.exports={classifyVerifiedTreatmentTurn,isStoppedDecision,
 chooseSecondaryFollowUpTreatment,latestMarketingIntentMatches,WITHDRAWN,DEFERRED,
 DISTANCE_OBJECTION,DISTANCE_OBJECTION_SQL};
