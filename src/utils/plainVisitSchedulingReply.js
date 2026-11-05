"use strict";
// A calendar-planning question, not a treatment-suitability assessment.
// Never imply that a slot is actually available, or that it is booked.
const {hasClinicalMediaRisk}=require("./aiReviewPolicy");
const SIMPLE_VISIT=/^(?:我|我们|我們|想|我想|我可不可以|可以)?\s*.{0,20}(?:新年|农历新年|農曆新年|过年|過年|春节|春節)(?:过后|過後|后|後).{0,22}(?:去|来|來|过去|過去|过来|過來|预约|預約).{0,12}(?:可以|方便|行|吗|嗎|么|呢|吗？|嗎？|\?)\s*[？?。!！]*$/u;
const ENGLISH=/^(?:can|could|may)\s+(?:i|we)\s+(?:come|visit|book)\s+(?:after|following)\s+(?:chinese\s+new\s+year|cny|new\s+year)\s*[?！!。]*$/iu;
const HEALTH=/(?:怀孕|懷孕|术后|術後|手术|手術|疼痛|痛|病|能不能做|能做|适合|適合|安全|脊椎|侧弯|側彎|surgery|pregnan|safe|suitable|pain)/iu;
function isSimpleVisitTimingQuestion(text){
 const value=String(text||"").trim();
 return value.length>0&&value.length<=110&&!HEALTH.test(value)&&
  !hasClinicalMediaRisk(value)&&(SIMPLE_VISIT.test(value)||ENGLISH.test(value));
}
function safeVisitTimingReply(language="zh"){
 const code=String(language).toLowerCase();
 return code.startsWith("en")
  ?"You can plan a visit after Chinese New Year 😊 Let us know your preferred date, and our team will check availability before confirming any appointment."
  :code.startsWith("ms")
   ?"Boleh rancang kunjungan selepas Tahun Baru Cina 😊 Beritahu tarikh pilihan anda, dan pihak pusat akan semak kekosongan sebelum mengesahkan temu janji."
   :"可以呀，新年过后想来可以先告诉我们你预计的日期 😊 门店会再帮你确认可预约时段，预约要以确认后的时间为准哦。";
}
module.exports={isSimpleVisitTimingQuestion,safeVisitTimingReply};
