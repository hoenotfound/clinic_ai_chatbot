"use strict";
// A customer cancellation request is not a completed CRM operation. Only an
// independently committed booking update can justify a completion claim.
const REQUEST=/(?:取消|cancel(?:ling|lation)?|batalkan|batal)/iu;
const BOOKING=/(?:预约|預約|预定|預定|订位|訂位|booking|appointment|reservation|slot|temujanji|janji temu)/iu;
const NEGATED=/(?:不要取消|不用取消|别取消|別取消|不取消|not\s+cancel|don.?t\s+cancel|jangan\s+batal)/iu;
const QUESTION=/(?:怎样|怎樣|怎么|怎麼|如何|how\s+(?:do\s+i|to)|can\s+i|could\s+i|if\s+i|如果|是否|boleh\s+tak)/iu;
function isDefiniteAppointmentCancellation(text){
 const value=String(text||"").trim();
 return value.length>0&&value.length<250&&REQUEST.test(value)&&BOOKING.test(value)&&
   !NEGATED.test(value)&&!QUESTION.test(value);
}
function cancellationReviewAcknowledgement(language="zh"){
 const lang=String(language).toLowerCase();
 if(lang.startsWith("en"))return "I understand you'd like to cancel your appointment. Our team needs to check and process the request. The booking is not confirmed cancelled yet, and they'll follow up with you.";
 if(lang.startsWith("ms"))return "Baik, kami faham anda ingin membatalkan janji temu. Pihak pusat perlu semak dan proses permintaan ini dahulu. Pembatalan belum disahkan; pihak kami akan menghubungi anda semula.";
 return "收到，你想取消预约。需要由门店同事核实并处理哦。目前还不能当作已经取消成功，确认后会再通知你。";
}
module.exports={isDefiniteAppointmentCancellation,cancellationReviewAcknowledgement};
