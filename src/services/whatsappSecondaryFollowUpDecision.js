"use strict";
// Only provider-verified customer text may set sender-specific follow-up context.
// This never grants marketing consent or bypasses a follow-up's normal eligibility.
const {resolveFollowUpTreatment}=require("./whatsappSecondaryFollowUpLanguage");

// A clear withdrawal pauses reminders even when the customer does not repeat
// a treatment name. Do not interpret questions such as "I don't know how" or
// "不是很清楚" as a refusal.
const WITHDRAWN=/(?:算了.{0,20}(?:不(?:要|做|考虑|考慮)|不用)|(?:^|[，,。!！\s])(?:暂时|暫時)?(?:不要了|不用了|不需要了|不做了|不考虑了|不考慮了)(?:[。!！\s😊🙏]*$)|(?:没兴趣|沒興趣|不感兴趣|不感興趣|不想(?:做|要|考虑|考慮)|不要(?:做|安排)(?:这个|這個)?|(?:^|\b)(?:not interested|no longer interested|don't want (?:it|this|the treatment)|do not want (?:it|this|the treatment)|rather not|not for me|tak berminat|tak nak|tak mahu|tidak berminat)(?:\b|$))/iu;
const DEFERRED=/(?:^(?:我|让我|讓我|先|暂时|暫時)?(?:再)?(?:考虑|考慮)(?:一下|看看|下|先)?[吧哦啊。.!！\s😊]*$|^(?:我再|我会再|我會再|迟点|遲點|过后|過後|之后|之後)(?:联系|聯繫|找|告诉|告訴|回复|回覆|通知)你|(?:let me (?:think|consider)|i(?:'ll| will) (?:let you know|get back(?: to you)?|contact you)|saya (?:akan )?(?:hubungi|beritahu) (?:nanti|kemudian)))/iu;

function classifyVerifiedTreatmentTurn({text,clinicConfig}={}){
 const value=String(text||"").normalize("NFKC").trim();
 if(!value || value.length>1500)return null;
 if(WITHDRAWN.test(value))return {status:"declined",treatment:null};
 if(DEFERRED.test(value))return {status:"deferred",treatment:null};
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
module.exports={classifyVerifiedTreatmentTurn,isStoppedDecision,WITHDRAWN,DEFERRED};
