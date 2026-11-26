"use strict";
const {hasSpecificStaffTimeOffer}=require("../services/staffAppointmentAcceptanceService");
const {parseStaffConfirmedSlot,parseTerseStaffConfirmedSlot,parseNaturalStaffConfirmedSlot}=require("../services/staffBookingConfirmationService");
const {isDefiniteAppointmentCancellation}=require("./appointmentCancellationSafety");
const {hasClinicalMediaRisk}=require("./aiReviewPolicy");
const PREFIX="[Verified STAFF message] ";

// Model interprets meaning. The exact matched row, its author, time and
// calendar facts are independently verified before any sales hold.
function resolveModelAppointmentEvidence({config,history,parsed,customerText,inboundId,bookingContext,now=Date.now()}={}){
  if(config?.businessType!=="tcm_clinic"||!/^neutro\s+sense\b/iu.test(String(config.businessName||config.clinicName||""))||
    config.aiPricingIntentMode!=="enabled"||!parsed?.structured||parsed.flagged||parsed.reviewRequired||
    parsed.languageCorrectionFailed||!["normal","booking_ready","no_reply"].includes(parsed.outcome)||
    ["set","visited","cancelled","reschedule"].includes(bookingContext?.status))return null;
  const kind=parsed.details?.appointmentIntent;
  const quote=parsed.details?.appointmentStaffEvidence;
  if(!["accepted","confirmed"].includes(kind)||typeof quote!=="string"||!quote.trim()||quote.length>240)return null;
  const value=String(customerText||"").trim();
  if(!value||isDefiniteAppointmentCancellation(value)||hasClinicalMediaRisk(value)||
    /(?:\b(?:cancel|reschedul\w*|cannot|can['’]t|not coming|not available|maybe|tukar|mungkin|batal)\b|取消|改期|改时间|改時間|不去了|不来了|不來了|不方便|没空|沒空|再看看)/iu.test(value))return null;
  const messages=Array.isArray(history)?history:[];
  const current=messages.at(-1);
  if(current?.role!=="user"||current.contextMessageId!==Number(inboundId))return null;
  const matches=messages.slice(0,-1).filter(row=>row?.role==="assistant"&&
    row.pricingVerifiedStaffText===true&&typeof row.content==="string"&&
    row.content.startsWith(PREFIX)&&row.content.slice(PREFIX.length).trim()===quote.trim()&&
    Number.isSafeInteger(row.contextMessageId)&&Number.isFinite(row.pricingCreatedAtMs)&&
    row.pricingCreatedAtMs<=current.pricingCreatedAtMs&&row.pricingCreatedAtMs>=now-24*3600_000);
  if(matches.length!==1)return null;
  const source=matches[0];
  if(kind==="accepted"){
    // A conversational "sure, that works for me" is meaningful only as a
    // response to a specific real staff time offer. No new booking is set.
    if(/[?？]/u.test(value)||!hasSpecificStaffTimeOffer(quote))return null;
    const prior=messages.slice(0,-1).at(-1);
    if(prior!==source)return null;
  } else {
    // A model-labelled confirmation may pause sales; it cannot write a
    // booking from conversation text. Require independently parsed slot.
    if(/[?？]/u.test(quote)||!/(?:\b(?:confirm(?:ed)?|comfirm(?:ed)?|booked|disahkan)\b|已确认|已確認|确认成功|確認成功|已订好|已訂好)/iu.test(quote)||
      /(?:\b(?:not|pending|maybe|tbc|if|cancel)\b|尚未|待确认|待確認|取消|如果)/iu.test(quote))return null;
    const clock=new Date(source.pricingCreatedAtMs);
    const slot=parseStaffConfirmedSlot(quote,clock)||parseNaturalStaffConfirmedSlot(quote,clock)||parseTerseStaffConfirmedSlot(quote,clock);
    if(!slot||Date.parse(slot)<=now)return null;
    // Do not revive a superseded confirmation. A later human conversation
    // with a conflicting appointment, withdrawal or reschedule is decisive.
    if(messages.slice(messages.indexOf(source)+1,-1).some(row=>
      (row.role==="user"||row.pricingVerifiedStaffText===true)&&
      /(?:\b(?:cancel|reschedul\w*|cannot|can['’]t|not available|tukar|batal)\b|取消|改期|改时间|改時間|不方便|不去了|不能来|不能來)/iu.test(String(row.content||""))))return null;
  }
  return {kind,id:source.contextMessageId,text:quote.trim()};
}
module.exports={resolveModelAppointmentEvidence};
