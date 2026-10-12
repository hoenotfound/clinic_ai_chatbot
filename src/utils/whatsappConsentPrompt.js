"use strict";

const YES_PREFIX="da_consent_yes:";
const NO_PREFIX="da_consent_no:";
const CONSENT_SCOPE="treatment_followups_and_related_offers";
const CONSENT_CATEGORY="MARKETING";
const YES_TEXT="同意接收跟进优惠";
const NO_TEXT="暂时不用";

function localizedService(name,language) {
  const service=String(name||"").trim();
  if(language==="zh")return service;
  const known=[
    [/骨盆|pelvic/i,["pelvic alignment treatment","rawatan penjajaran pelvis"]],
    [/小颜|小顏|3d|face bone/i,["3D face contouring","rawatan kontur wajah 3D"]],
    [/9d|逆龄|逆齡|anti.age/i,["9D anti-aging treatment","rawatan anti-penuaan 9D"]],
  ];
  const matched=known.find(([pattern])=>pattern.test(service));
  return matched?matched[1][language==="ms"?1:0]:service;
}
function consentQuestion({serviceName,businessName,language="zh"}) {
  const business=String(businessName||"").trim();
  const service=localizedService(serviceName,language);
  if(!service||!business)return null;
  if(language==="en"){
    return `By the way, may ${business} send you WhatsApp follow-ups and related offers about ${service}? 😊`;
  }
  if(language==="ms"){
    return `Oh ya, boleh ${business} WhatsApp anda untuk follow-up, info rawatan dan tawaran berkaitan ${service}? 😊`;
  }
  return `对了～之后如果有关于${service}的资讯或相关优惠，${business} 可以继续 WhatsApp 跟进通知您吗？😊`;
}
function consentButtons(promptId,language="zh") {
  const id=Number(promptId);
  if(!Number.isSafeInteger(id)||id<=0)throw new Error("Invalid consent request");
  const titles=language==="en"
    ? ["Yes, updates/offers","Not now"]
    : language==="ms"
      ? ["Ya, saya setuju","Tak mahu"]
      : [YES_TEXT,NO_TEXT];
  return [
    {id:`${YES_PREFIX}${id}`,title:titles[0]},
    {id:`${NO_PREFIX}${id}`,title:titles[1]},
  ];
}
module.exports={
  YES_PREFIX,NO_PREFIX,CONSENT_SCOPE,CONSENT_CATEGORY,YES_TEXT,NO_TEXT,
  consentQuestion,consentButtons,localizedService,
};
