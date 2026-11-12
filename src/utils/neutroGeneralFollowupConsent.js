"use strict";

// This is an invitation, NOT an automatic permission. Customers must send
// the exact affirmative sentence themselves after a delivered 20h reminder.
// New Meta ad clicks and unreadable 131060 messages never grant consent.
const GENERAL_SCOPE="general_clinic_followups_and_related_offers";
const GENERAL_SERVICE="neutro_general_tcm_care";
const SENTENCES=Object.freeze({
 zh:"我同意通过 WhatsApp 接收 Neutro Sense TCM 的中医护理跟进与相关优惠",
 en:"I agree to receive WhatsApp follow-ups and related offers about TCM care from Neutro Sense TCM",
 ms:"Saya setuju menerima susulan WhatsApp dan tawaran penjagaan TCM daripada Neutro Sense TCM",
});
const INVITATIONS=Object.freeze({
 zh:`若希望之后6天内继续收到 Neutro Sense TCM 的 WhatsApp 中医护理资讯及相关优惠，请完整回复：
「${SENTENCES.zh}」
不想接收可忽略。`,
 en:`If you want WhatsApp TCM care follow-ups and related offers from Neutro Sense TCM over the next 6 days, please reply with this full sentence:
"${SENTENCES.en}"
This is optional; no reply is needed.`,
 ms:`Jika mahu terima susulan penjagaan TCM dan tawaran berkaitan daripada Neutro Sense TCM melalui WhatsApp untuk 6 hari seterusnya, sila balas dengan ayat penuh ini:
"${SENTENCES.ms}"
Ini pilihan anda; tidak perlu balas jika tidak berminat.`,
});
function normalize(value){
 return String(value||"").normalize("NFKC").replace(/[’‘]/g,"'")
  .replace(/\s+/g," ").trim().replace(/^[\"“”「『]|[\"“”」』。.!！]+$/g,"").trim().toLowerCase();
}
function explicitGeneralFollowupConsent(text){
 if(typeof text!=="string"||text.length>350)return null;
 const normalized=normalize(text);
 for(const [language,sentence] of Object.entries(SENTENCES)){
  if(normalized===normalize(sentence))return {language,category:"MARKETING",
   scope:GENERAL_SCOPE,service:GENERAL_SERVICE,method:"customer_whatsapp_text"};
 }
 return null;
}
function invitation(language="zh"){return INVITATIONS[language]||INVITATIONS.zh;}
module.exports={GENERAL_SCOPE,GENERAL_SERVICE,SENTENCES,INVITATIONS,
 explicitGeneralFollowupConsent,invitation};
