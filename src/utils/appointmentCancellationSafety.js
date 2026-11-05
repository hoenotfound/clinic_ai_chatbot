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
// Keep ordinary administrative questions eligible for routine follow-ups.
// A pending, message-linked cancellation review, however, is an active
// request for staff to change the appointment and suspends sales reminders
// until that review is explicitly resolved.
// Match the same request, booking, negation and question rules as
// isDefiniteAppointmentCancellation(). The follow-up gate must not accept a
// smaller vocabulary than the review creator (notably slot / temujanji).
// Postgres uses POSIX whitespace classes rather than JavaScript \\s.
function cancellationRequestSqlExpression(contentSql){
 const value=`COALESCE(${contentSql},'')`;
 return `(
   CHAR_LENGTH(BTRIM(${value})) BETWEEN 1 AND 249
   AND ${value} ~* '(取消|cancel(ling|lation)?|batalkan|batal)'
   AND ${value} ~* '(预约|預約|预定|預定|订位|訂位|booking|appointment|reservation|slot|temujanji|janji temu)'
   AND ${value} !~* '(不要取消|不用取消|别取消|別取消|不取消|not[[:space:]]+cancel|don.?t[[:space:]]+cancel|jangan[[:space:]]+batal)'
   AND ${value} !~* '(怎样|怎樣|怎么|怎麼|如何|how[[:space:]]+(do[[:space:]]+i|to)|can[[:space:]]+i|could[[:space:]]+i|if[[:space:]]+i|如果|是否|boleh[[:space:]]+tak)'
 )`;
}
function pendingCancellationFollowupAllowedSql(alias="c"){
 if(!/^[a-z][a-z0-9_]*$/iu.test(alias))throw new TypeError("Invalid contact SQL alias");
 return `NOT EXISTS (
  SELECT 1 FROM ai_review_items cancellation_review
  JOIN messages cancellation_inbound
    ON cancellation_inbound.id=cancellation_review.inbound_message_id
     AND cancellation_inbound.contact_id=${alias}.id
     AND cancellation_inbound.role='user'
  WHERE cancellation_review.contact_id=${alias}.id
    AND cancellation_review.status='pending'
    AND cancellation_review.category='information'
    AND ${cancellationRequestSqlExpression("cancellation_inbound.content")}
 )`;
}
module.exports={isDefiniteAppointmentCancellation,cancellationReviewAcknowledgement,pendingCancellationFollowupAllowedSql};
