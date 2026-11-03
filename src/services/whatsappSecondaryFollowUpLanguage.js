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
function resolveFollowUpTreatment({clinicConfig,customerTexts,treatmentInterest}={}){
 const services=(Array.isArray(clinicConfig?.services)?clinicConfig.services:[])
   .map(x=>String(x?.name||"").trim()).filter(Boolean);
 const aliases=Array.isArray(clinicConfig?.serviceAliases)?clinicConfig.serviceAliases:[];
 const normalize=x=>String(x||"").trim().toLocaleLowerCase();
 // The clinic config lists a combined 3D + 9D treatment as well as its
 // individual services. A combined enquiry naturally matches all three
 // aliases. Prefer the explicitly requested combination, but never assume
 // that an "or" / comparison enquiry is a combined treatment.
 const combined=services.filter(name=>/3\s*d/i.test(name)&&/9\s*d/i.test(name));
 const joint=/3\s*d[\s\S]{0,28}(?:\+|&|\band\b|dan|和|跟|与|一起)[\s\S]{0,28}9\s*d|9\s*d[\s\S]{0,28}(?:\+|&|\band\b|dan|和|跟|与|一起)[\s\S]{0,28}3\s*d/i;
 const comparison=/\b(?:or|vs|versus|compare|difference|either)\b|还是|或者|比较|区别|分别|哪个|哪一个/i;
 for(const message of Array.isArray(customerTexts)?customerTexts:[]){
   const msg=normalize(message);if(!msg)continue;
   const named=services.filter(service=>{
     const terms=[service,...aliases.filter(a=>normalize(a?.officialService)===normalize(service))
       .map(a=>a.alias)].map(normalize).filter(t=>t.length>1);
     return terms.some(term=>msg.includes(term));
   });
   if(combined.length===1 && /3\s*d/i.test(msg) && /9\s*d/i.test(msg) &&
     !comparison.test(msg)){
     const combinedName=combined[0];
     const names=[combinedName,...aliases.filter(a=>
       normalize(a?.officialService)===normalize(combinedName)).map(a=>a.alias)];
     const explicit=names.map(normalize).some(term=>term.length>3&&
       /3\s*d/i.test(term)&&/9\s*d/i.test(term)&&msg.includes(term));
     if(explicit||joint.test(msg))return combinedName;
   }
   if(named.length>1)return null;
   if(named.length===1)return named[0];
 }
 return services.find(service=>normalize(service)===normalize(treatmentInterest))||null;
}
function localizedFollowUpText({
 slot,originalText,customerTexts,languageEvidenceTexts,treatmentInterest,clinicConfig,
 forceGeneral=false,
}={}){
 const config=clinicConfig?.automatedFollowUp;
 if(config && [2,6,20].includes(Number(slot))){
   const lang=detectConversationLanguage(
     Array.isArray(customerTexts)?customerTexts.filter(x=>typeof x==="string"):[],null) ||
     detectConversationLanguage(
       Array.isArray(languageEvidenceTexts)?languageEvidenceTexts.filter(x=>typeof x==="string"):[],null);
   if(!lang)return null;
   const step=Number(slot)===2?config:Number(slot)===6?config.additionalSteps?.[0]:config.additionalSteps?.[1];
   if(!step)return null;
   const overrides=Array.isArray(step.serviceOverrides)?step.serviceOverrides:[];
   const service=forceGeneral ? null
     : resolveFollowUpTreatment({clinicConfig,customerTexts,treatmentInterest});
   const selected=service?overrides.find(x=>x.serviceName===service):null;
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
module.exports={localizedFollowUpText,resolveFollowUpTreatment};
