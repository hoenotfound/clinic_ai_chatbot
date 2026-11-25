"use strict";
// Manual-only secondary chats stay manual. Classify only for staff routing,
// never to authorize an AI response, a booking, a price or marketing media.
const {hasClinicalMediaRisk}=require("./aiReviewPolicy");
const {isRm68ClinicalConcern}=require("./neutroRm68InterestEvidence");
const {isGreetingOrLanguageOnly}=require("./chatLanguage");
const {hasCustomerServiceEnquiry,stripFutureFollowUpPermission}=require("./customerEnquiryEvidence");
const {isDefiniteAppointmentCancellation}=require("./appointmentCancellationSafety");
const {isSimpleVisitTimingQuestion}=require("./plainVisitSchedulingReply");
const {detectDate,localParts,parseClockPreference}=require("./appointmentHoursGuard");
const {hasExplicitMarketingRefusal}=require("./marketingRefusal");

const APPOINTMENT=/(?:\b(?:appointment|book(?:ing)?|available\s+slots?|any\s+slots?|schedule|reschedul(?:e|ing)|visit\s+(?:today|tomorrow)|temujanji|janji temu|slot\s+kosong|running late|be late|on my way)\b|预约|預約|约时间|約時間|有位|空位|能安排|可以安排|迟到|遲到|会迟|會遲)/iu;
const SCHEDULE_ACTION=/(?:\b(?:confirm(?:ed|ation)?|change|move|come|visit|available|free|can make|cancel|set|sah(?:kan)?|datang|tukar|lapang|batal)\b|确认|確認|确定|確定|改期|取消|方便|过来|過來|可以来|可以來|可以吗|可以嗎)/iu;
const PACKAGE=/(?:配套|套餐|疗程|療程|会员|會員|余额|餘額|\b(?:packages?|sessions?|credits?|membership|balance|treatments?|pakej|sesi|baki|keahlian)\b)/iu;
const EXISTING=/(?:之前|上次|已经|已經|买过|買過|购买|購買|还剩|還剩|剩[余餘下几幾多少]|剩|有效期|到期|退款|转让|轉讓|\b(?:remaining|left|unused|purchased|bought|paid|already|previous|last|my|expiry|expire|refund|transfer|baki|tinggal|dah beli|sudah beli|masih ada)\b)/iu;
const REQUEST=/(?:[?？]|请问|請問|想问|想問|想知道|想了解|可以帮|可以幫|麻烦|麻煩|帮我|幫我|请帮|請幫|我要|需要|怎么办|怎麼辦|如何|哪里|哪裡|多少|几时|幾時|几次|幾次|\b(?:please|can|could|would|may|how|what|where|when|which|why|check|help|need|want to|looking for|boleh|tolong|nak tahu|berapa|bila|mana|macam mana|kenapa|semak)\b)/iu;
const ACK=/^(?:(?:ok(?:ay)?|kk|noted|sure|yes|yeah|yep|no|nope|fine|later|got it|received|i am considering|i['’]m considering|i will think about it|thanks?(?:\s+(?:you|dear|ya))?|thank you(?:\s+dear)?|tq|thx|好的|好|谢谢|謝謝|收到|明白|嗯|哦|是的|可以|再考虑|再考慮|考虑看看|考慮看看|baik|terima kasih|faham|boleh|ya|tak)[\s.!！。~👍🙏😊🙂❤️]*)+$/iu;
const REFUSAL=/^(?:stop|unsubscribe|not interested|no thanks|no thank you|不要了|不需要了|不用了|停止|退订|退訂|tak nak|tidak berminat)[\s.!！。~]*$/iu;
const healthReason="Manual-only secondary WhatsApp: customer mentioned a health concern. Staff should review the latest message before discussing treatment.";
const appointmentReason="Manual-only secondary WhatsApp: customer asked about an appointment. Staff should check the latest message and availability.";
const accountReason="Manual-only secondary WhatsApp: customer needs help with an existing package or account. Staff should verify the records and reply.";
const generalReason="Manual-only secondary WhatsApp: unanswered customer enquiry. Staff should check the latest message and reply.";

function manualOnlySecondaryAttention(text,{receivedAt=Date.now()}={}){
 const value=String(text||"").normalize("NFKC").trim();
 if(!value || !/[\p{L}\p{N}]/u.test(value) || value.startsWith("📎 ["))return null;
 // Reuse the shared clinical policy, including recent childbirth, medical
 // history, contraindications and affirmative symptom evidence.
 const health=hasClinicalMediaRisk(value)||
   (/(?:胸部|乳房|乳腺|breast|RM\s*68)/iu.test(value)&&isRm68ClinicalConcern(value))||
   /(?:\b(?:injur(?:y|ed)|numbness|tingling)\b|受伤|受傷|麻痹|下背痛|腰痛)/iu.test(value);
 if(health)return {reason:healthReason,kind:"health"};
 // A simple date/time by itself is actionable in an existing staff chat,
 // as is a confirmation with a date. Reuse the existing MYT date parser.
 const local=localParts(receivedAt);
 const date=local&&detectDate(value,local.date);
 const clock=parseClockPreference(value);
 const scheduleEvidence=Boolean(date?.date || date?.ambiguous || clock?.times?.length ||
   clock?.time || clock?.tokens?.length);
 if(APPOINTMENT.test(value)||isDefiniteAppointmentCancellation(value)||isSimpleVisitTimingQuestion(value)||
    (scheduleEvidence&&(SCHEDULE_ACTION.test(value)||REQUEST.test(value)))||
    (scheduleEvidence && /^[\p{N}\s/:.,-]+(?:am|pm)?[\s?？]*$/iu.test(value)))
   return {reason:appointmentReason,kind:"appointment"};
 if(PACKAGE.test(value)&&EXISTING.test(value))return {reason:accountReason,kind:"account"};
 // Ignore stand-alone greetings, acknowledgements, refusals, and a
 // consent-only prefill. Do not ignore a separate current request within it.
 if(isGreetingOrLanguageOnly(value)||ACK.test(value)||REFUSAL.test(value))return null;
 const consent=stripFutureFollowUpPermission(value);
 const requestText=String(consent.text||"").trim();
 if(consent.hasFuturePermission&&!REQUEST.test(requestText)&&
    !/(?:[?？]|\b(?:check|how much|price|cost|remaining)\b|价钱|价格|收费|剩几次)/iu.test(requestText))return null;
 if(hasExplicitMarketingRefusal(value)&&!REQUEST.test(value))return null;
 // Broad fallback for direct questions/requests (including admin questions
 // and unfamiliar wording) rather than a treatment-specific keyword list.
 // This raises staff attention only; it does not trigger Gemini or a send.
 if(REQUEST.test(requestText)||(!consent.hasFuturePermission&&hasCustomerServiceEnquiry(requestText)))
   return {reason:generalReason,kind:"enquiry"};
 return null;
}
module.exports={manualOnlySecondaryAttention};
