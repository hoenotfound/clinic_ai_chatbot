"use strict";
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
module.exports={usesNaturalReplyAuthority,recordedReviewAcknowledgement,createReplyOverrideAudit};
