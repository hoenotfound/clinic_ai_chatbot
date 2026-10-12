"use strict";

const YES_PREFIX="da_consent_yes:";
const NO_PREFIX="da_consent_no:";
const CONSENT_SCOPE="treatment_followups_and_related_offers";
const CONSENT_CATEGORY="MARKETING";
const YES_TEXT="同意接收跟进优惠";
const NO_TEXT="暂时不用";

// Keep business/service explicit in the question. In Neutro Sense's pelvic
// conversations this is the exact clinic-approved Chinese wording.
function consentQuestion({ serviceName, businessName }) {
  const service=String(serviceName||"").trim();
  const business=String(businessName||"").trim();
  if (!service || !business) return null;
  return `对了～之后如果有关于${service}的资讯或相关优惠，${business} 可以继续 WhatsApp 跟进通知您吗？😊`;
}
function consentButtons(promptId) {
  const id=Number(promptId);
  if (!Number.isSafeInteger(id) || id<=0) throw new Error("Invalid consent request");
  return [
    { id:`${YES_PREFIX}${id}`,title:YES_TEXT },
    { id:`${NO_PREFIX}${id}`,title:NO_TEXT },
  ];
}
module.exports={
  YES_PREFIX,NO_PREFIX,CONSENT_SCOPE,CONSENT_CATEGORY,YES_TEXT,NO_TEXT,
  consentQuestion,consentButtons,
};
