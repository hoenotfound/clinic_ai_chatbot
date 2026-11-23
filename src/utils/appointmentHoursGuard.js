"use strict";

// Shared appointment-preference validation. Actual slot availability is staff-owned.
// Values come from clinicConfig.hours.weekly (loaded from Neon Settings).
const ZONE = "Asia/Kuala_Lumpur";
const DAYS = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
const ZH_DAYS = ["星期日","星期一","星期二","星期三","星期四","星期五","星期六"];
const MS_DAYS = ["Ahad","Isnin","Selasa","Rabu","Khamis","Jumaat","Sabtu"];
const WEEK_ALIASES = [
  ["sunday","sun","ahad"],["monday","mon","isnin"],["tuesday","tue","selasa"],
  ["wednesday","wed","rabu"],["thursday","thu","khamis"],
  ["friday","fri","jumaat"],["saturday","sat","sabtu"],
];
const SCHEDULE_TURN = /(?:预约|預約|约|約|安排|时间|時間|空档|空檔|方便|今天|明天|后天|後天|星期|礼拜|禮拜|周[一二三四五六日天]|週[一二三四五六日天]|早上|上午|下午|晚上|中午|点|點|\b(?:appointment|book|booking|visit|slot|available|today|tomorrow|weekday|weekend|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|isnin|selasa|rabu|khamis|jumaat|sabtu|ahad|temujanji|janji temu|pukul|hari ini|esok)\b)/iu;
function localParts(at = new Date()) {
  const value = new Date(at);
  if (!Number.isFinite(value.getTime())) return null;
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB",{
    timeZone:ZONE,year:"numeric",month:"2-digit",day:"2-digit",
    hour:"2-digit",minute:"2-digit",hourCycle:"h23",
  }).formatToParts(value).filter(x=>x.type!=="literal").map(x=>[x.type,+x.value]));
  const date=[p.year,String(p.month).padStart(2,"0"),String(p.day).padStart(2,"0")].join("-");
  return {date,weekday:new Date(date+"T12:00:00Z").getUTCDay(),minute:p.hour*60+p.minute};
}
function weekday(date){return new Date(date+"T12:00:00Z").getUTCDay();}
function plusDays(date,n){return new Date(Date.parse(date+"T12:00:00Z")+n*86400000).toISOString().slice(0,10);}
function validDate(y,m,d){
  const date=String(y).padStart(4,"0")+"-"+String(m).padStart(2,"0")+"-"+String(d).padStart(2,"0");
  const timestamp=Date.parse(date+"T12:00:00Z");
  return y>=2000&&y<2100&&Number.isFinite(timestamp)&&
    new Date(timestamp).toISOString().slice(0,10)===date?date:null;
}
function detectDate(text,anchorDate){
  const source=String(text||"").normalize("NFKC");
  const found=new Set();
  const add=(v)=>{if(v)found.add(v);};
  for(const m of source.matchAll(/\b(20\d{2})[/-](\d{1,2})[/-](\d{1,2})\b/gu)) add(validDate(+m[1],+m[2],+m[3]));
  for(const m of source.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?\b/gu)){
    if(m.index>0&&/[\d/-]/u.test(source[m.index-1]))continue;
    const year=m[3]?+m[3]:+anchorDate.slice(0,4);
    let date=validDate(year,+m[2],+m[1]);
    if(!m[3]&&date&&date<anchorDate)date=validDate(year+1,+m[2],+m[1]);
    add(date);
  }
  for(const [pattern,offset] of [
    [/(?:今天|今日|\btoday\b|\bhari ini\b)/iu,0],
    [/(?:明天|\btomorrow\b|\besok\b)/iu,1],
    [/(?:后天|後天|\bday after tomorrow\b|\blusa\b)/iu,2],
  ])if(pattern.test(source))add(plusDays(anchorDate,offset));
  for(const m of source.matchAll(/(下(?:个|個)?(?:星期|礼拜|禮拜|周|週)|(?:星期|礼拜|禮拜|周|週))\s*([一二三四五六日天1-7])/gu)){
    const target=/^[1-7]$/u.test(m[2])?+m[2]%7:
      m[2]==="日"||m[2]==="天"?0:"一二三四五六".indexOf(m[2])+1;
    let distance=(target-weekday(anchorDate)+7)%7;
    if(m[1].startsWith("下")) {
      const daysSinceMonday=(weekday(anchorDate)+6)%7;
      distance=7-daysSinceMonday+((target+6)%7);
    }
    add(plusDays(anchorDate,distance));
  }
  for(let d=0;d<WEEK_ALIASES.length;d++){
    const pattern=new RegExp("\\b(?:(next|this|coming)\\s+)?(?:"+WEEK_ALIASES[d].join("|")+")\\b","giu");
    for(const m of source.matchAll(pattern)){
      let distance=(d-weekday(anchorDate)+7)%7;
      if(m[1]==="next"&&distance===0)distance=7;
      add(plusDays(anchorDate,distance));
    }
  }
  return found.size===1?{date:[...found][0]}:found.size>1?{ambiguous:true}:null;
}
function toMinute(hhmm){
  if(!/^\d{1,2}:\d{2}$/u.test(String(hhmm||"")))return null;
  const [h,m]=hhmm.split(":").map(Number);
  return h<24&&m<60?h*60+m:null;
}
function intervals(hours,dayIndex){
  const weekly=hours?.weekly;
  if(!weekly||typeof weekly!=="object"||Array.isArray(weekly)||
     !Object.prototype.hasOwnProperty.call(weekly,DAYS[dayIndex]))return null;
  const raw=weekly[DAYS[dayIndex]];
  if(raw===null||raw===false||raw?.closed===true)return [];
  const slots=Array.isArray(raw)?raw:[raw];
  const times=slots.map(s=>[toMinute(s?.open),toMinute(s?.close)]);
  return times.every(([open,close])=>open!==null&&close!==null&&close>open)?times:null;
}
function timesInText(text){
  const value=String(text||"").normalize("NFKC");
  const period=/(?:下午|傍晚|晚上|\bafternoon\b|\bevening\b|\bpetang\b|\bmalam\b)/iu.test(value)?"pm":
    /(?:上午|早上|\bmorning\b|\bpagi\b)/iu.test(value)?"am":"";
  const times=[];
  for(const m of value.matchAll(/(?:^|\b)(\d{1,2})(?:[:：](\d{2})|(点|點|时|時)(?:(\d{1,2})分?)?)\s*(a\.?m\.?|p\.?m\.?)?/giu)){
    let h=+m[1],minute=+(m[2]||m[4]||0);
    if(h>23||minute>59)continue;
    const suffix=(m[5]||period).toLowerCase();
    if(suffix.startsWith("p")&&h<12)h+=12;
    if(suffix.startsWith("a")&&h===12)h=0;
    if(!suffix&&h>0&&h<8)continue;
    times.push(h*60+minute);
  }
  // Simple forms like "2pm" and "3 am" have no colon or Chinese 点.
  for (const m of value.matchAll(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/giu)) {
    let hour = +m[1];
    if (hour < 1 || hour > 12) continue;
    if (m[2].toLowerCase().startsWith("p") && hour < 12) hour += 12;
    if (m[2].toLowerCase().startsWith("a") && hour === 12) hour = 0;
    times.push(hour * 60);
  }
  return [...new Set(times)];
}
function durationMinutesForPackage({config,customerTexts=[],treatment=""}={}){
  const selected=customerTexts.join(" ").toLowerCase();
  const durations=[];
  for(const promotion of config?.promotions||[]){
    if(treatment&&promotion.linkedService&&promotion.linkedService!==treatment)continue;
    for(const pkg of promotion.packages||[]){
      const name=String(pkg.name||"").toLowerCase();
      if(!name||!selected.includes(name))continue;
      const caption=String(pkg.caption||"")+" "+String(pkg.title||"");
      const cn=/(\d+)\s*(?:小时|小時)\s*(?:(\d+)\s*(?:分钟|分鐘|分))?/u.exec(caption);
      const en=/(\d+)\s*h(?:ours?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/iu.exec(caption);
      const minutes=/(\d+)\s*(?:minutes?|分钟|分鐘)/iu.exec(caption);
      const length=cn?+cn[1]*60+(+cn[2]||0):en?+en[1]*60+(+en[2]||0):minutes?+minutes[1]:0;
      if(length>0&&length<=480)durations.push(length);
    }
  }
  return durations.length===1?durations[0]:0;
}
function evaluateAppointmentHours({hours,customerText="",recentCustomerTexts=[],
  appointmentPreference="",receivedAt=new Date(),now=new Date(),durationMinutes=0}={}){
  if(!hours?.weekly)return {status:"unconfigured"};
  const anchor=localParts(receivedAt),today=localParts(now);
  if(!anchor||!today)return {status:"unknown"};
  let selected=null;
  for(const text of [customerText,...recentCustomerTexts,appointmentPreference]){
    const found=detectDate(text,anchor.date);
    if(found?.ambiguous)return {status:"ambiguous"};
    if(found?.date){selected=found.date;break;}
  }
  if(!selected)return {status:"unknown"};
  const day=weekday(selected),opening=intervals(hours,day);
  const info={date:selected,weekday:day};
  if(opening===null)return {status:"unconfigured",...info};
  if(!opening.length)return {status:"closed",...info};
  if(selected<today.date)return {status:"past",...info};
  let times=timesInText(customerText);
  if(!times.length)times=timesInText(appointmentPreference);
  if(!times.length)return {status:"valid_day",...info};
  const length=Math.max(0,Math.min(480,Number(durationMinutes)||0));
  const inHours=times.some(t=>opening.some(([open,close])=>t>=open&&t+length<=close));
  const possible=times.some(t=>opening.some(([open,close])=>
    t>=open&&t+length<=close&&(selected!==today.date||t>today.minute)));
  return {status:possible?"valid_preference":inHours?"past":"outside_hours",...info};
}
function issueReply(issue,{hours,language="zh"}={}){
  let alternative=null;
  for(let i=1;i<=7;i++){
    const day=weekday(plusDays(issue.date,i));
    if(intervals(hours,day)?.length){alternative=day;break;}
  }
  const lang=String(language).toLowerCase().slice(0,2);
  if(lang==="en"){
    const reason=issue.status==="closed"?"we're closed on "+DAYS[issue.weekday]:
      issue.status==="past"?"that time has already passed":"that time is outside our opening hours";
    return "Sorry, "+reason+" 😊 "+(alternative!==null?"Would "+DAYS[alternative]+" suit you instead? ":"Could you suggest another day? ")+
      "Our team will check the slot before confirming.";
  }
  if(lang==="ms"){
    const reason=issue.status==="closed"?"pusat kami tutup hari "+MS_DAYS[issue.weekday]:
      issue.status==="past"?"masa itu sudah berlalu":"masa itu di luar waktu operasi kami";
    return "Maaf ya, "+reason+" 💚 "+(alternative!==null?"Hari "+MS_DAYS[alternative]+" sesuai tak? ":"Ada hari lain yang sesuai? ")+
      "Kami akan semak kekosongan sebelum mengesahkan temu janji 😊";
  }
  const reason=issue.status==="closed"?ZH_DAYS[issue.weekday]+"是休息日":
    issue.status==="past"?"这个时间已经过了":"这个时间不在营业时段内";
  return "不好意思哦～"+reason+"💚 "+(alternative!==null?ZH_DAYS[alternative]+"方便吗？":"其他日期方便吗？")+
    "我可以先帮您向诊所确认空档，预约要确认后才算哦☺️";
}
function guardAppointmentReply({hours,reply,customerText="",recentCustomerTexts=[],
  appointmentPreference="",receivedAt,now,language="zh",durationMinutes=0}={}){
  const original=String(reply||"");
  // Merely mentioning "today" in a promotion or price question must NOT
  // turn that enquiry into an appointment correction.
  const schedulingRequest = /(?:预约|預約|约时间|約時間|安排|空档|空檔|有空|方便|可以(?:吗|嗎)|几点|幾點|几时|幾時|营业|營業|休息|开门|開門|关门|關門|\b(?:appointment|book|booking|visit|slot|available|availability|open|closed|temujanji|janji temu|pukul|boleh datang|boleh book)\b)/iu.test(customerText);
  const explicitTime = timesInText(customerText).length > 0;
  const shortDayAnswer = String(customerText).trim().length <= 15 &&
    /^(?:今天|明天|后天|後天|星期[一二三四五六日天]|(?:下星期|周|週|下周|下週)[一二三四五六日天]|\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)[？?.!！。\s]*$/iu.test(customerText);
  if (!SCHEDULE_TURN.test(customerText) ||
      (!schedulingRequest && !explicitTime && !shortDayAnswer)) {
    return {reply:original,blocked:false};
  }
  const issue=evaluateAppointmentHours({hours,customerText,recentCustomerTexts,
    appointmentPreference,receivedAt,now,durationMinutes});
  if(!["closed","past","outside_hours"].includes(issue.status))
    return {reply:original,blocked:false,issue};
  if(issue.status==="closed"&&/(休息|不营业|不營業|closed|tutup)/iu.test(original)&&
      !/(?:今天|today|hari ini).{0,30}(?:确认|確認|check|semak|空档|空檔)/iu.test(original))
    return {reply:original,blocked:true,issue};
  return {reply:issueReply(issue,{hours,language}),blocked:true,issue};
}
function currentClinicDate(value=new Date()){
  const p=localParts(value);
  return p?DAYS[p.weekday]+", "+p.date+" "+
    String(Math.floor(p.minute/60)).padStart(2,"0")+":"+
    String(p.minute%60).padStart(2,"0")+" ("+ZONE+")":"Malaysia time unavailable";
}
module.exports={ZONE,localParts,detectDate,intervals,timesInText,
  durationMinutesForPackage,evaluateAppointmentHours,issueReply,
  guardAppointmentReply,currentClinicDate};
