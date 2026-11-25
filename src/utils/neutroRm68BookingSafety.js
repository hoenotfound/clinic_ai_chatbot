"use strict";
const {isExplicitRm68Interest}=require("./neutroRm68InterestEvidence");
const {latestCustomerTreatmentChoice}=require("./neutroRm68TreatmentChoice");
const {isNeutro,hasCampaignConversation,stillDiscussingCampaign,
 isOtherTreatmentQuery}=require("./neutroBreastRm68Campaign");
// An event name is not a configured treatment choice. Booking readiness may
// record a proposed time, but cannot convert RM68 event interest into the
// unrelated herbal breast-care treatment in CRM or its staff summary.
function sanitizeRm68BookingReadyDetails({
 details,customerText,history=[],channel,clinicConfig,
}={}){
 const original=details && typeof details==="object"?details:{};
 if(channel!=="whatsapp"||clinicConfig?.businessType!=="tcm_clinic"||
    !isNeutro(clinicConfig?.businessName||clinicConfig?.clinicName)||
    !original.treatment)return original;
 const latest=String(customerText||"");
 const customerExplicitHerbal=latestCustomerTreatmentChoice(history,latest,"herbal");
 // The AI must never create herbal-care booking interest from just "RM68",
 // "breast care", or a date/time. A directly customer-named herbal treatment
 // may still be recorded through the existing normal booking flow.
 if(original.treatment==="草药胸部疏通乳腺护理"&&!customerExplicitHerbal)
  return {...original,treatment:null,
   staffSummary:"Staff should verify the customer's actual treatment request; do not infer the herbal breast-care treatment from a generic breast-care or RM68 enquiry."};
 const campaignActive=isExplicitRm68Interest(latest)||
   (hasCampaignConversation(history)&&stillDiscussingCampaign(history));
 if(!campaignActive||isOtherTreatmentQuery(latest)||customerExplicitHerbal)
  return original;
 return {...original,treatment:null,
   staffSummary:"Customer enquired about the RM68 breast-care event. Staff must confirm the actual service and requested slot; do not treat this event as a standalone herbal or full-body treatment."};
}
module.exports={sanitizeRm68BookingReadyDetails};
