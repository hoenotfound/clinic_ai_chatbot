"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const path=require("node:path");
const consent=require("../src/utils/neutroGeneralFollowupConsent");
const inbound=require("../src/db/whatsappInboundConsentRepo");
const service=require("../src/services/whatsappSecondaryFollowUpService");

test("general six-day invitation is optional, scoped and preserves STOP",()=>{
 for(const language of ["zh","en","ms"]){
  const sentence=consent.SENTENCES[language];
  const invitation=consent.invitation(language);
  assert.ok(invitation.includes(sentence));
  assert.match(invitation,/Neutro Sense TCM/);
  assert.match(invitation,/STOP PROMOTIONS|停止优惠/);
  const captured=consent.explicitGeneralFollowupConsent(sentence);
  assert.deepEqual(captured,{
   language,category:"MARKETING",
   scope:"general_clinic_followups_and_related_offers",
   service:"neutro_general_tcm_care",
   method:"customer_whatsapp_text"
  });
 }
});
test("ad prefills, unsupported messages and ordinary acknowledgements are NEVER general marketing consent",()=>{
 for(const text of [
  "你好！想了解你们家的【黄金脉冲技术】",
  "📎 [Customer sent a WhatsApp message that could not be displayed]",
  "Yes","I agree","OK","好的","可以","我想了解骨盆调理",
  "No, don't send me WhatsApp promotions",
  "I agree to receive WhatsApp follow-ups and related offers",
  "Neutro Sense TCM",
  "Saya setuju","stop promotions",
  consent.SENTENCES.zh+"不要",
 ]){
  assert.equal(consent.explicitGeneralFollowupConsent(text),null,text);
 }
});
test("secondary 20h customer service slot can invite explicit permission without automatically permitting Day4/Day6",()=>{
 const src=fs.readFileSync(path.join(__dirname,"../src/services/whatsappSecondaryFollowUpService.js"),"utf8");
 const inboundClaim=fs.readFileSync(path.join(__dirname,"../src/services/inboundMessageClaimService.js"),"utf8");
 const repoSrc=fs.readFileSync(path.join(__dirname,"../src/db/whatsappInboundConsentRepo.js"),"utf8");
 assert.match(src,/slot===20 && candidate\.lead_marketing_consent!=="opted_in"/);
 assert.match(src,/candidate\.recovery_no_selection===true \|\|/);
 assert.match(src,/candidate\.verified_meta_ad===true/);
 assert.match(src,/generalSixDayInvitation\(replyLanguage\)/);
 assert.match(src,/verified_meta_ad/);
 assert.match(inboundClaim,/explicitGeneralFollowupConsent\(incoming\?\.text\)/);
 assert.match(repoSrc,/!isClickToWhatsApp/);
 assert.match(repoSrc,/sender_key='neutro_secondary'/);
 assert.match(repoSrc,/prompt\.is_automated_follow_up=TRUE/);
 assert.match(repoSrc,/prompt\.delivery_status IN \('sent','delivered','read'\)/);
 assert.match(repoSrc,/prompt\.content LIKE/);
 assert.match(repoSrc,/generalExplicit\?GENERAL_SCOPE:explicit\.scope/);
 assert.match(repoSrc,/generalExplicit\?GENERAL_SERVICE/);
 assert.doesNotMatch(service.CANDIDATES_SQL,/general_clinic_followups_and_related_offers/,
  "service follow-ups do not claim any marketing permission");
});
