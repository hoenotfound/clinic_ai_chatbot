"use strict";
// Keep a 2h/6h follow-up in the language evidenced by the secondary contact.
// Unclear conversations are skipped instead of sending an unrelated Chinese
// message. The text is localized from Neutro's staff-approved Chinese copy.
const {detectConversationLanguage}=require("../utils/chatLanguage");
const translated=Object.freeze({
  2:Object.freeze({
    en:"Hi! If you'd still like to know more about the treatment you asked about, I can help 😊 Would you prefer to know how it works or how to arrange a first visit?",
    ms:"Hai! Kalau masih nak tahu lebih lanjut tentang rawatan tadi, saya boleh bantu 😊 Nak tahu proses rawatan atau cara atur sesi pertama?",
  }),
  6:Object.freeze({
    en:"If you'd like to know more about the treatment you asked about, feel free to ask 😊 Would you like to know what to expect during the visit or how to prepare?",
    ms:"Kalau masih nak tahu tentang rawatan tadi, boleh tanya ya 😊 Nak tahu apa yang berlaku semasa sesi atau apa yang perlu disediakan sebelum datang?",
  }),
});
function localizedFollowUpText({
 slot,originalText,customerTexts,treatmentInterest,clinicConfig,
}={}){
 const config=clinicConfig?.automatedFollowUp;
 if(config && [2,6].includes(Number(slot))){
   const lang=detectConversationLanguage(
     Array.isArray(customerTexts)?customerTexts.filter(x=>typeof x==="string"):[],null);
   if(!lang)return null;
   const step=Number(slot)===2?config:config.additionalSteps?.[0];
   if(!step)return null;
   const overrides=Array.isArray(step.serviceOverrides)?step.serviceOverrides:[];
   const service=(Array.isArray(clinicConfig.services)?clinicConfig.services:[])
     .find(x=>String(x.name||"").trim().toLowerCase()===
       String(treatmentInterest||"").trim().toLowerCase());
   const selected=service?overrides.find(x=>x.serviceName===service.name):null;
   const source=selected||step;
   return String(source?.translations?.[lang]||source?.message||"").trim()||null;
 }

 if(![2,6].includes(Number(slot)))return originalText;
 const language=detectConversationLanguage(
   Array.isArray(customerTexts)?customerTexts.filter(x=>typeof x==="string"):[],
   null
 );
 if(language==="zh")return String(originalText||"").trim()||null;
 return translated[Number(slot)]?.[language]||null;
}
module.exports={localizedFollowUpText};
