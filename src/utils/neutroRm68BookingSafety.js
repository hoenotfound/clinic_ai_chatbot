"use strict";
const {isExplicitRm68Interest}=require("./neutroRm68InterestEvidence");
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
    !(isExplicitRm68Interest(customerText)||
      (hasCampaignConversation(history)&&stillDiscussingCampaign(history)))||
    isOtherTreatmentQuery(customerText)||
    /(?:草药|草藥|herbal).{0,14}(?:胸部|乳腺|breast)|草药胸部疏通乳腺护理/iu.test(
      String(customerText||"")))return original;
 return {...original,treatment:null,
   staffSummary:"Customer enquired about the RM68 breast-care event. Staff must confirm the actual service and requested slot; do not assume it is the herbal breast-care treatment."};
}
module.exports={sanitizeRm68BookingReadyDetails};
