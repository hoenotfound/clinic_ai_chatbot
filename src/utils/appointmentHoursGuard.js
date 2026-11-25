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

// Calendar names used in Malaysian English and Malay.
const MONTH_NAMES=[
  ["january","jan","januari"],["february","feb","februari"],["march","mar","mac"],
  ["april","apr"],["may","mei"],["june","jun"],["july","jul","julai"],
  ["august","aug","ogos"],["september","sept","sep"],["october","oct","oktober","okt"],
  ["november","nov"],["december","dec","disember","dis"],
];
const MONTH_PATTERN=MONTH_NAMES.flat().sort((a,b)=>b.length-a.length).join("|");
const DAY_FIRST="\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?("+MONTH_PATTERN+")\\.?(?:\\s*,?\\s*(20\\d{2}))?(?!\\w)";
const MONTH_FIRST="\\b("+MONTH_PATTERN+")\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:\\s*,?\\s*(20\\d{2}))?(?!\\w)";
function monthNumber(name){return MONTH_NAMES.findIndex(names=>names.includes(name.toLowerCase()))+1;}
function calendarDate(year,month,day,anchorDate){
  const y=year?+year:+anchorDate.slice(0,4);
  const date=validDate(y,month,day);
  return !year&&date&&date<anchorDate&&+anchorDate.slice(5,7)>=11&&month<=2?validDate(y+1,month,day):date;
}
const DAYPART=/(?:上午|早上|中午|下午|晚上|傍晚|凌晨|\bmorning\b|\bafternoon\b|\bevening\b|\bpagi\b|\bpetang\b|\bmalam\b|\btengah hari\b)/iu;
const APPOINTMENT_HISTORY_LIMIT = 20;
const SHORT_CONTEXT_MS = 36*3600000;
const MAX_CONTEXT_MS = 30*24*3600000;
const BARE_TIME=/^(?:(?:at|pukul|jam)\s+)?(?:\d{1,2}(?:[:.：]\d{2})?\s*(?:a\.?m\.?|p\.?m\.?|pagi|petang|malam|tengah hari)|\d{1,2}[:.：]\d{2}|(?:上午|早上|中午|下午|晚上|傍晚)?[零〇一二两兩三四五六七八九十\d]{1,3}\s*(?:点|點|时|時)(?:\s*(?:半|[零〇一二两兩三四五六七八九十\d]{1,3}\s*分?))?|(?:morning|afternoon|evening|pagi|petang|malam|tengah hari|上午|早上|中午|下午|晚上|傍晚))[？?.!！。\s]*$/iu;
function preferenceText(text){
  return String(text||"").normalize("NFKC").trim()
    .replace(/^(?:yes|please|ok(?:ay)?|baik|boleh)[,\s]+/iu,"")
    .replace(/(?:[,\s]+(?:please|pls|thanks|thank you|ya|ok(?:ay)?(?:\s+ma)?|terima kasih|boleh)|[，,\s]*(?:谢谢|謝謝|可以吗|可以嗎|可以的))[。.!?！？\s]*$/iu,"").trim();
}
function isBareTimePreference(text){return BARE_TIME.test(preferenceText(text));}
// A day number is never a date by itself; resolve only against customer evidence.
function partialCalendarDay(text){
  const match=/^(\d{1,2})\s*[号號日]\s*(?:哦|噢|喔|啊|呀|啦|呢|哈)?[。.!?！？\s]*$/u.exec(preferenceText(text));
  return match&&+match[1]>=1&&+match[1]<=31?+match[1]:null;
}
function explicitCalendarText(text){
  return /\d{1,2}[/-]\d{1,2}|\d{1,2}月\s*\d{1,2}/u.test(text)||
    new RegExp(DAY_FIRST,"iu").test(text)||new RegExp(MONTH_FIRST,"iu").test(text);
}
function customerDateEvidence(content,anchorDate){
  if(/(?:旧预约|之前的预约|上次预约|old booking|previous appointment|last appointment)/iu.test(content))return false;
  return schedulingEvidence(content,anchorDate)||
    (explicitCalendarText(content)&&
      /(?:不是说了|不是說了|已经说了|已經說了|我说了|我說了|already (?:said|told))/iu.test(content)&&
      !/(?:优惠|促销|价格|活动|promo|price|offer)/iu.test(content));
}
function rejectsPreference(text){
  return /(?:取消(?:预约|預約)?|不(?:要|想|能|可以)(?:来|來|过来|過來|预约|預約)|不能(?:了|来|來)|\b(?:cancel(?:led|ling)?|cannot (?:come|make it|attend)|can't (?:come|make it|attend)|not available|no longer interested|(?:decided|choose|chosen) not to proceed|(?:do not|don't|won't) (?:want to )?proceed|not proceeding|tak jadi|batal(?:kan)?|tak boleh datang)\b|\b(?:cannot|can't|not possible|doesn['’]t work|won['’]t work)\s*[.!?]*$|不(?:行|方便|可以)[。！？\s]*$)/iu.test(text);
}
function isBareCalendarPreference(text,anchorDate){
  const value=preferenceText(text);
  if(!detectDate(value,anchorDate))return false;
  const rest=value.replace(new RegExp(DAY_FIRST,"giu"),"")
    .replace(new RegExp(MONTH_FIRST,"giu"),"")
    .replace(/\b(?:20\d{2}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}[/-]\d{1,2}(?:[/-]20\d{2})?)\b/gu,"")
    .replace(/(?:20\d{2}年\s*)?\d{1,2}月\s*\d{1,2}[日号號]?/gu,"")
    .replace(/(?:今天|今日|明天|后天|後天|(?:下|这|這|本)?(?:个|個)?(?:星期|周|週|礼拜)[一二三四五六日天1-7])/gu,"")
    .replace(/\b(?:day after tomorrow|today|tomorrow|hari ini|esok|lusa)\b/giu,"")
    .replace(new RegExp("\\b(?:(?:next|this|coming|hari)\\s+)?(?:"+WEEK_ALIASES.flat().join("|")+")\\b","giu"),"")
    .replace(/^[\s,，。.!?！？-]+|[\s,，。.!?！？-]+$/gu,"").trim();
  return !rest||isBareTimePreference(rest);
}
function appointmentHistory({recentCustomerMessages,recentCustomerTexts,receivedAt,now,maxAgeMs=SHORT_CONTEXT_MS}){
  const history=recentCustomerMessages.length?recentCustomerMessages:
    recentCustomerTexts.map(content=>({content,createdAt:receivedAt}));
  const latest=new Date(receivedAt).getTime(),current=new Date(now).getTime();
  return history.map(item=>{
    const content=typeof item==="string"?item:String(item?.content||"");
    const at=typeof item==="string"?receivedAt:(item?.createdAt||item?.created_at||item?.pricingCreatedAtMs||null);
    const timestamp=at==null?NaN:new Date(at).getTime();
    return {content,timestamp,local:Number.isFinite(timestamp)?localParts(timestamp):null};
  }).filter(item=>item.local&&item.timestamp<=latest&&item.timestamp<=current+120000&&
    current-item.timestamp<=maxAgeMs).sort((a,b)=>b.timestamp-a.timestamp).slice(0,APPOINTMENT_HISTORY_LIMIT);
}
function schedulingEvidence(content,anchorDate){
  const visit=/(?:预约|預約|安排|过来|過來|来店|來店|有空|方便|可以(?:吗|嗎)|几点|幾點|几时|幾時|\b(?:appointment|booking|book|visit|slot|available|come|temujanji|janji temu)\b)/iu;
  const promo=/(?:优惠|促销|价格|价钱|活动|promotion|discount|promo|price|offer|diskaun)/iu;
  return (!promo.test(content)||/(?:预约|預約|\b(?:appointment|book|visit)\b)/iu.test(content))&&
    (visit.test(content)||isBareCalendarPreference(content,anchorDate)||isBareTimePreference(content));
}

function parseCalendar(text,anchorDate){
  const source=String(text||"").normalize("NFKC");
  if(!anchorDate || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate))return null;
  const found=new Set();
  let invalid=false;
  const add=(v)=>{if(v)found.add(v);else invalid=true;};
  for(const m of source.matchAll(/\b(20\d{2})[/-](\d{1,2})[/-](\d{1,2})\b/gu))
    add(validDate(+m[1],+m[2],+m[3]));
  for(const m of source.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?\b/gu)){
    if(m.index>0&&/[\d/-]/u.test(source[m.index-1]))continue;
    add(calendarDate(m[3],+m[2],+m[1],anchorDate));
  }
  for(const m of source.matchAll(/(?:(20\d{2})年\s*)?(\d{1,2})月\s*(\d{1,2})[日号號]?/gu))
    add(calendarDate(m[1],+m[2],+m[3],anchorDate));
  // Match day-first expressions once, then mask their spans so "29 November
  // 3.00 PM" cannot also be misread as November 3.
  const dayFirstMatches=[...source.matchAll(new RegExp(DAY_FIRST,"giu"))];
  for(const m of dayFirstMatches)add(calendarDate(m[3],monthNumber(m[2]),+m[1],anchorDate));
  let remaining=source;
  for(const m of dayFirstMatches.slice().reverse())
    remaining=remaining.slice(0,m.index)+" ".repeat(m[0].length)+remaining.slice(m.index+m[0].length);
  for(const m of remaining.matchAll(new RegExp(MONTH_FIRST,"giu"))){
    if(/^(?:[:.]\d|\s*(?:am|pm)\b)/iu.test(remaining.slice(m.index+m[0].length)))continue;
    add(calendarDate(m[3],monthNumber(m[1]),+m[2],anchorDate));
  }
  const explicitDates=[...found];
  const weekdayDate=(day,prefix,date)=>{
    if(!prefix&&explicitDates.length===1&&weekday(explicitDates[0])===day&&
      !/(?:\bor\b|\band\b|或者|还是|還是|或|\batau\b)/iu.test(source))return;
    add(date);
  };
  for(const [pattern,offset] of [
    [/(?:今天|今日|\btoday\b|\bhari ini\b)/iu,0],
    [/(?:明天|(?<!day after )\btomorrow\b|\besok\b)/iu,1],
    [/(?:后天|後天|\bday after tomorrow\b|\blusa\b)/iu,2],
  ])if(pattern.test(source))add(plusDays(anchorDate,offset));
  for(const m of source.matchAll(/((?:下|这|這|本)(?:个|個)?(?:星期|礼拜|禮拜|周|週)|(?:星期|礼拜|禮拜|周|週))\s*([一二三四五六日天1-7])/gu)){
    const target=/^[1-7]$/u.test(m[2])?+m[2]%7:
      m[2]==="日"||m[2]==="天"?0:"一二三四五六".indexOf(m[2])+1;
    let distance=(target-weekday(anchorDate)+7)%7;
    if(m[1].startsWith("下")){
      const daysSinceMonday=(weekday(anchorDate)+6)%7;
      distance=7-daysSinceMonday+((target+6)%7);
    }
    weekdayDate(target,m[1].startsWith("下")?"next":"",plusDays(anchorDate,distance));
  }
  for(let d=0;d<WEEK_ALIASES.length;d++){
    const pattern=new RegExp("\\b(?:(next|this|coming)\\s+)?(?:"+WEEK_ALIASES[d].join("|")+")\\b","giu");
    for(const m of source.matchAll(pattern)){
      let distance=(d-weekday(anchorDate)+7)%7;
      if(m[1]?.toLowerCase()==="next")distance=7-(weekday(anchorDate)+6)%7+(d+6)%7;
      weekdayDate(d,m[1],plusDays(anchorDate,distance));
    }
  }
  const dates=[...found];
  return invalid?{invalid:true,dates}:dates.length===1?{date:dates[0],dates}:dates.length>1?{ambiguous:true,dates}:null;
}
function detectDate(text,anchorDate){
  const parsed=parseCalendar(text,anchorDate);
  return parsed?.invalid?null:parsed?.date?{date:parsed.date}:parsed?.ambiguous?{ambiguous:true}:null;
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

// Clock extraction is deliberately separate from conversational intent.
// Each clock retains its source span; a range is not a pair of alternatives.
function parseClockPreference(text){
  const value=String(text||"").normalize("NFKC");
  const tokens=[];
  const digits={"零":0,"〇":0,"一":1,"二":2,"两":2,"兩":2,"三":3,"四":4,
    "五":5,"六":6,"七":7,"八":8,"九":9,"十":10};
  function number(input){
    if(/^\d{1,2}$/.test(input))return +input;
    if(input==="十")return 10;
    if(input.startsWith("十"))return 10+(digits[input.slice(1)]||0);
    if(input.endsWith("十"))return (digits[input.slice(0,-1)]||0)*10;
    if(input.includes("十")){
      const [a,b]=input.split("十");
      return (digits[a]||0)*10+(digits[b]||0);
    }
    return Object.prototype.hasOwnProperty.call(digits,input)?digits[input]:null;
  }
  const periodPattern=/(?:下午|傍晚|晚上|\bafternoon\b|\bevening\b|\bpetang\b|\bmalam\b|上午|早上|凌晨|\bmorning\b|\bpagi\b)/giu;
  function markerFromWord(word){
    return /下午|傍晚|晚上|afternoon|evening|petang|malam/iu.test(word)?"pm":"am";
  }
  function add(m,h,min,marker="",explicit=false){
    const index=m.index, end=index+m[0].length;
    if(tokens.some(t=>index<t.end&&end>t.index))return;
    tokens.push({index,end,h,min,marker,explicit});
  }
  for(const m of value.matchAll(/([零〇一二两兩三四五六七八九十\d]{1,3})\s*(?:点|點|时|時)(?:\s*(半|[零〇一二两兩三四五六七八九十\d]{1,3})\s*分?)?/gu))
    add(m,number(m[1]),m[2]==="半"?30:m[2]?number(m[2]):0);
  for(const m of value.matchAll(/(?<!\d)(\d{1,2})[:.：](\d{2})(?:\s*(a\.?m\.?|p\.?m\.?|pagi|petang|malam|tengah hari))?(?!\d)/giu)){
    const suffix=String(m[3]||"").toLowerCase().replace(/\./g,"");
    const marker=/^(?:am|pm)$/.test(suffix)?suffix:suffix?(/petang|malam|tengah hari/.test(suffix)?"pm":"am"):"";
    add(m,+m[1],+m[2],marker,Boolean(suffix));
  }
  for(const m of value.matchAll(/(?<![\d:.：])\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?|pagi|petang|malam|tengah hari)\b/giu)){
    const suffix=m[2].toLowerCase().replace(/\./g,"");
    add(m,+m[1],0,/^(?:am|pm)$/.test(suffix)?suffix:/petang|malam|tengah hari/.test(suffix)?"pm":"am",true);
  }
  // "3 to 5pm" shares the suffix of the second endpoint. A date/price
  // numeral is never treated as a clock without a range connector.
  for(const m of value.matchAll(/(?<![\d:.])\b(\d{1,2})\s*(?=(?:to|until|[-–])\s*\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)\b)/giu))
    add(m,+m[1],0);
  tokens.sort((a,b)=>a.index-b.index);
  const periods=[...value.matchAll(periodPattern)];
  const connector=/^\s*(?:to|until|through|[-–—~]|至|到|hingga|sampai)\s*$/iu;
  const between=(a,b)=>value.slice(a.end,b.index);
  let invalid=false;
  for(let i=0;i<tokens.length;i++){
    const t=tokens[i],prior=tokens[i-1],next=tokens[i+1];
    let marker=t.marker;
    if(!marker){
      const nearby=periods.filter(p=>p.index<t.index&&p.index>=(prior?.end||0)).at(-1);
      if(nearby)marker=markerFromWord(nearby[0]);
      else if(next&&connector.test(between(t,next))&&next.marker)marker=next.marker;
      else if(prior&&/^\s*(?:to|until|through|[-–—~]|至|到|或(?:者)?|还是|還是|or|atau|hingga|sampai)\s*$/iu.test(between(prior,t))&&prior.resolvedMarker)marker=prior.resolvedMarker;
    }
    if(!Number.isInteger(t.h)||!Number.isInteger(t.min)||t.h<0||t.h>23||t.min<0||t.min>59||
      (t.explicit&&(t.h<1||t.h>12))){
      invalid=true;continue;
    }
    t.resolvedMarker=marker;
    let h=t.h;
    if(marker==="pm"&&h>0&&h<12)h+=12;
    if(marker==="am"&&h===12)h=0;
    if(!marker&&h>0&&h<8){t.ambiguous=true;continue;}
    t.minute=h*60+t.min;
    // Only local, explicit rejection counts. Complex corrections are left
    // to the model/clarification, not guessed by choosing the last number.
    const before=value.slice(prior?.end||0,t.index);
    const after=value.slice(t.end,next?.index??value.length);
    t.rejected=/(?:\bnot|\bexcept|\bno|不要|不是|不能|不选|不選|bukan|jangan)\s*$/iu.test(before)||
      /^\s*[,，]\s*(?:no[,\s]+actually|actually|sorry[,\s]+(?:i mean|make it)|更正|改成|改为|改為|换成|換成)/iu.test(after)||
      /^\s*(?:[,，]?\s*)?(?:not (?:possible|available|good|suitable|okay|ok)|doesn['’]t work|won['’]t work|cannot\b|can't\b|不行|不方便|不可以|tak boleh|tidak sesuai)/iu.test(after);
  }
  const accepted=tokens.filter(t=>Number.isInteger(t.minute)&&!t.rejected);
  const ranges=[];
  for(let i=0;i<tokens.length-1;i++){
    const a=tokens[i],b=tokens[i+1];
    if(!connector.test(between(a,b)))continue;
    if(!Number.isInteger(a.minute)||!Number.isInteger(b.minute)||a.rejected||b.rejected||a.minute>=b.minute){
      invalid=true;continue;
    }
    ranges.push([a.minute,b.minute]);
  }
  // Mixed alternatives/ranges require clarification rather than collapsing
  // distinct meanings. Keep the exact range endpoints if a single window.
  const range=ranges.length===1&&accepted.length===2?ranges[0]:null;
  if(ranges.length&&!range)invalid=true;
  return {times:[...new Set(accepted.map(t=>t.minute))],range,invalid,
    rejected:tokens.some(t=>t.rejected),hasClock:tokens.length>0};
}
function timesInText(text){return parseClockPreference(text).times;}

function durationFromText(text){
  const source=String(text||"").normalize("NFKC");
  // Ranges use the upper estimate so a booking cannot overrun closing.
  const range=/(\d+)\s*[-–~至到]\s*(\d+)\s*(?:分钟|分鐘|minutes?|mins?)/iu.exec(source);
  if(range)return Math.max(+range[1],+range[2]);
  const cn=/(\d+)\s*(?:小时|小時)\s*(?:(\d+)\s*(?:分钟|分鐘|分))?/u.exec(source);
  const en=/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|jam|h)\b\s*(?:(\d+)\s*(?:minutes?|mins?|minit|m)\b)?/iu.exec(source);
  const minutes=/(\d+)\s*(?:minutes?|mins?|minit|分钟|分鐘)/iu.exec(source);
  const length=cn?+cn[1]*60+(+cn[2]||0):en?Math.round(+en[1]*60)+(+en[2]||0):minutes?+minutes[1]:0;
  return length>0&&length<=480?length:0;
}
function durationMinutesForPackage({config,customerTexts=[],treatment=""}={}){
  const source=(Array.isArray(customerTexts)?customerTexts:[]).map(s=>String(s||"").toLowerCase());
  // The newest explicit package choice wins; old A enquiries must not
  // override a new B choice merely because both appear in bounded history.
  for(const turn of source){
    const matching=[];
    for(const promotion of config?.promotions||[]){
      if(treatment&&promotion.linkedService&&promotion.linkedService!==treatment)continue;
      for(const pkg of promotion.packages||[]){
        const names=[pkg.name,pkg.title,...(Array.isArray(pkg.aliases)?pkg.aliases:[])]
          .map(x=>String(x||"").trim().toLowerCase()).filter(Boolean);
        if(!names.some(name=>turn.includes(name)))continue;
        const duration=Number(pkg.durationMinutes)||durationFromText(
          [pkg.duration,pkg.title,pkg.caption,...Object.values(pkg.mediaTranslations||{}).map(x=>x?.caption)].join(" "));
        if(duration>0&&duration<=480)matching.push(duration);
      }
    }
    if(matching.length)return Math.max(...matching);
  }
  const service=(config?.services||[]).find(item=>
    String(item?.name||"").toLowerCase()===String(treatment||"").toLowerCase());
  if(!service)return 0;
  return Number(service.durationMinutes)||durationFromText(
    [service.duration,service.durationText,service.sessionDuration,service.description].join(" "));
}

function evaluateAppointmentHours({hours,customerText="",recentCustomerTexts=[],
  recentCustomerMessages=[],recentStaffMessages=[],appointmentPreference="",receivedAt=new Date(),now=new Date(),
  durationMinutes=0,trustPreferenceWithoutCustomer=false}={}){
  if(!hours?.weekly)return {status:"unconfigured"};
  const anchor=localParts(receivedAt),today=localParts(now);
  if(!anchor||!today)return {status:"unknown"};
  const current=parseCalendar(customerText,anchor.date);
  const currentClock=parseClockPreference(customerText);
  const hasTime=currentClock.times.length>0||DAYPART.test(customerText);
  if(rejectsPreference(customerText)&&!(currentClock.rejected&&currentClock.times.length))return {status:"not_appointment"};
  if(current?.invalid)return {status:"invalid_date",hasTime};
  if(current?.ambiguous)return {status:"ambiguous",dates:current.dates,hasTime};
  let selected=current?.date||null;
  let selectedIndex=-1;
  const history=appointmentHistory({recentCustomerMessages,recentCustomerTexts,receivedAt,now,maxAgeMs:MAX_CONTEXT_MS});
  const boundary=history.findIndex(item=>rejectsPreference(item.content));
  const activeHistory=boundary<0?history:history.slice(0,boundary);
  const dayOnly=partialCalendarDay(customerText);
  const modelDate=parseCalendar(appointmentPreference,anchor.date)?.date;
  const continuation=isBareTimePreference(customerText)||dayOnly!==null;
  // Authenticated staff text corroborates the thread, not customer consent.
  const staffHistory=appointmentHistory({recentCustomerMessages:recentStaffMessages,
    recentCustomerTexts:[],receivedAt,now,maxAgeMs:MAX_CONTEXT_MS});
  const staffExchange=staffHistory.find(item=>{
    const parsed=parseCalendar(item.content,item.local.date);
    return parsed&&(asksSchedulingQuestion(item.content)||
      (parseClockPreference(item.content).hasClock&&
        /(?:可以吗|可以嗎|方便|[?？]|\b(?:can|would|could|boleh)\b)/iu.test(item.content)));
  });
  const staffDate=staffExchange?parseCalendar(staffExchange.content,staffExchange.local.date)?.date:null;
  if(!selected){
    for(let i=0;i<activeHistory.length;i++){
      const {content,local}=activeHistory[i];
      const found=parseCalendar(content,local.date);
      if(found?.invalid&&!/promotion|promo|优惠|促销/iu.test(content))return {status:"invalid_date",hasTime};
      if(!customerDateEvidence(content,local.date))continue;
      if(found?.ambiguous)return {status:"ambiguous",dates:found.dates,hasTime};
      if(found?.date&&found.date>=today.date){
        const older=new Date(now).getTime()-activeHistory[i].timestamp>SHORT_CONTEXT_MS;
        // Preserve explicit future dates across days only when the current
        // scheduling reply and model or authenticated staff corroborate them.
        if(older&&(!continuation||!explicitCalendarText(content)||
          (modelDate!==found.date&&staffDate!==found.date)))break;
        if(dayOnly!==null&&+found.date.slice(8)!==dayOnly)
          return {status:"unknown",hasTime};
        selected=found.date;selectedIndex=i;break;
      }
      if(found?.date&&found.date<today.date)return {status:"unknown",hasTime};
    }
  }
  if(!selected&&trustPreferenceWithoutCustomer&&dayOnly===null){
    const found=parseCalendar(appointmentPreference,anchor.date);
    if(found?.invalid)return {status:"invalid_date",hasTime};
    if(found?.ambiguous)return {status:"ambiguous",dates:found.dates,hasTime};
    selected=found?.date||null;
  }
  if(!selected)return {status:"unknown",hasTime};
  const day=weekday(selected),opening=intervals(hours,day);
  const info={date:selected,weekday:day};
  if(opening===null)return {status:"unconfigured",...info};
  if(selected<today.date)return {status:"past",...info};
  if(!opening.length)return {status:"closed",...info};
  // Never cross a superseding date or cancellation to recover an old time.
  const matchingHistory=[];
  for(let i=0;i<activeHistory.length;i++){
    const item=activeHistory[i];
    const referenced=parseCalendar(item.content,item.local.date);
    if(referenced?.invalid||referenced?.ambiguous||(referenced?.date&&referenced.date!==selected))break;
    if(referenced?.date===selected&&customerDateEvidence(item.content,item.local.date)){
      matchingHistory.push(item);continue;
    }
    if(!referenced&&isBareTimePreference(item.content)&&new Date(now).getTime()-item.timestamp<=SHORT_CONTEXT_MS){
      if(selectedIndex>=0&&i<selectedIndex){matchingHistory.push(item);continue;}
      if(selectedIndex<0&&i===0&&isBareCalendarPreference(customerText,anchor.date)&&
        new Date(receivedAt).getTime()-item.timestamp<=5*60000&&
        !activeHistory.slice(1).some(x=>parseCalendar(x.content,x.local.date)))matchingHistory.push(item);
    }
  }
  let timeText=customerText;
  const invalidClock=text=>{const clock=parseClockPreference(text);return clock.invalid||(clock.hasClock&&!clock.times.length);};
  if(invalidClock(timeText))return {status:"valid_day",...info};
  if(!timesInText(timeText).length&&!DAYPART.test(timeText)){
    for(const {content} of matchingHistory){
      if(parseClockPreference(content).hasClock||DAYPART.test(content)){timeText=content;break;}
    }
  }
  if(!timesInText(timeText).length&&!DAYPART.test(timeText)&&trustPreferenceWithoutCustomer)
    timeText=appointmentPreference;
  if(invalidClock(timeText))return {status:"valid_day",...info};
  const clock=parseClockPreference(timeText);
  const times=clock.times;
  const length=Math.max(0,Math.min(480,Number(durationMinutes)||0));
  const fits=t=>opening.some(([open,close])=>t>=open&&t<close&&t+length<=close);
  const future=t=>selected!==today.date||t>today.minute;
  if(!times.length){
    const part=daypartInText(timeText);
    if(!part)return {status:"valid_day",...info};
    const [from,to]=DAYPART_RANGES[part];
    const canFit=opening.some(([open,close])=>Math.max(open,from)<Math.min(close,to)&&
      Math.max(open,from)+length<=Math.min(close,to));
    const canFitFuture=opening.some(([open,close])=>{
      const start=Math.max(open,from,selected===today.date?today.minute+1:0);
      return start<Math.min(close,to)&&start+length<=Math.min(close,to);
    });
    return {status:canFitFuture?"valid_preference":canFit?"past":"outside_hours",...info,daypart:part};
  }
  if(clock.range){
    const [from,to]=clock.range;
    // The range is a window of acceptable start times, not an exact slot.
    // Intersect it with opening hours and latest feasible start.
    const windows=opening.map(([open,close])=>[
      Math.max(from,open,selected===today.date?today.minute+1:0),
      Math.min(to,close-Math.max(1,length))
    ]).filter(([start,end])=>start<=end);
    if(windows.length)return {status:"valid_preference",...info,range:clock.range,validWindows:windows};
    const overlaps=opening.some(([open,close])=>Math.max(from,open)<=Math.min(to,close-Math.max(1,length)));
    return {status:overlaps?"past":"outside_hours",...info,range:clock.range};
  }
  const validTimes=times.filter(t=>fits(t)&&future(t));
  return {status:validTimes.length?"valid_preference":times.some(fits)?"past":"outside_hours",...info,
    times:validTimes,requestedTimes:times};
}
const DAYPART_RANGES={morning:[360,720],noon:[660,840],afternoon:[720,1080],evening:[1080,1440],overnight:[0,360]};
function daypartInText(text){
  const value=String(text||"");
  if(/凌晨/u.test(value))return "overnight";
  if(/(?:傍晚|晚上|\bevening\b|\bmalam\b)/iu.test(value))return "evening";
  if(/(?:下午|\bafternoon\b|\bpetang\b)/iu.test(value))return "afternoon";
  if(/(?:中午|\btengah hari\b)/iu.test(value))return "noon";
  if(/(?:上午|早上|\bmorning\b|\bpagi\b)/iu.test(value))return "morning";
  return null;
}
function asksSchedulingQuestion(text){
  return /(?:\b(?:which|what|preferred)\s+(?:day|date|time)|\b(?:when|what time)\s+(?:would|can|are|do|you)|\b(?:date|day|time)\b.{0,35}\b(?:prefer|suit|convenient|work for you)|weekday or weekend|哪一天|哪天|几时|幾時|几点|幾點|什么时候|甚麼時候|星期几|星期幾|hari mana|tarikh mana|pukul berapa|bila.*sesuai)/iu.test(text);
}
function claimsConfirmedAppointment(text){
  // Positive assertions only; an offer to check/confirm or an explicit
  // disclaimer is not a confirmation. Verified staff bookings bypass this guard.
  const clauses=String(text||"").split(/[。！？!?;\n]|\.(?=\s+[A-Z])/u);
  return clauses.some(clause=>{
    const value=clause.trim();
    if(/(?:\bnot (?:yet )?(?:confirmed|booked|reserved)|\b(?:once|after|when|before|until)\b.{0,25}\bconfirm|尚未|还没|還沒|确认后|確認後|belum disahkan|selepas disahkan)/iu.test(value)&&
      !/(?:\b(?:is|has been|you're|you are)\s+(?:already\s+)?confirmed|已经确认|已經確認)/iu.test(value))return false;
    return /(?:\b(?:appointment|booking|reservation|slot|visit)\b.{0,30}\b(?:is|has been|now|successfully|already)\s*(?:been\s+)?(?:confirmed|booked|reserved|secured|set)|\b(?:appointment|booking|reservation|slot)\s+(?:confirmed|booked|reserved|secured)\b|\b(?:confirmed|booked|reserved)\s+(?:your|the)\s+(?:appointment|booking|slot)\b|(?:预约成功|預約成功|预约确认成功|預約確認成功)|\b(?:you(?:'re| are) (?:all set|booked|confirmed)|(?:i|we)(?:'ve| have) (?:booked|reserved|confirmed)|see you (?:on|at|then))\b|(?:预约|預約|订位|訂位|时段|時段).{0,12}(?:已(?:经|經)?确认|已(?:经|經)?確認|确认成功|確認成功|预约成功|預約成功|安排好了)|(?:已(?:经|經)?帮您|已(?:经|經)?幫您).{0,10}(?:预约|預約|留位)|\b(?:janji temu|temujanji|tempahan|slot)\b.{0,25}\b(?:telah|sudah)\s+(?:disahkan|ditempah|ditetapkan))/iu.test(value);
  });
}
function canRecoverBookingReady({customerText,previousAssistantText,issue}={}){
  if(issue?.status!=="valid_preference"||rejectsPreference(customerText))return false;
  const prompt=String(previousAssistantText||"");
  const promptDate=parseCalendar(prompt,issue.date)?.date;
  const datedOffer=promptDate===issue.date&&parseClockPreference(prompt).times.length>0&&
    /(?:可以吗|可以嗎|方便|[?？]|\b(?:can|would|could|boleh)\b)/iu.test(prompt);
  return (asksSchedulingQuestion(prompt)||datedOffer)&&
    (isBareCalendarPreference(customerText,issue.date)||isBareTimePreference(customerText)||
      partialCalendarDay(customerText)===+issue.date.slice(8));
}
function verifiedAppointmentPreference(issue){
  if(issue?.status!=="valid_preference"||!issue.date)return null;
  const clock=t=>String(Math.floor(t/60)).padStart(2,"0")+":"+String(t%60).padStart(2,"0");
  const time=issue.range?issue.range.map(clock).join("–"):issue.times?.length?issue.times.map(clock).join(" or "):issue.daypart;
  return time?issue.date+" "+time:null;
}

// Staff context is customer-authored and kept apart from canonical scheduling
// data. Do not repeat old dates, clocks, booking claims or model assertions.
function appointmentCustomerContext({customerText="",recentCustomerMessages=[],receivedAt=new Date(),now=new Date()}={}){
  const anchor=localParts(receivedAt);
  if(!anchor)return [];
  const history=appointmentHistory({recentCustomerMessages,recentCustomerTexts:[],receivedAt,now});
  const result=[];
  for(const {content,local} of [{content:customerText,local:anchor},...history]){
    if(rejectsPreference(content))break;
    const value=String(content||"").trim().replace(/\s+/gu," ");
    if(value.length<6||parseCalendar(value,local.date)||parseClockPreference(value).hasClock||
      DAYPART.test(value)||claimsConfirmedAppointment(value)||SCHEDULE_TURN.test(value)||
      /^(?:yes|okay|thank you|thanks|alright|可以的|好的|谢谢|baik|terima kasih)[.!。\s]*$/iu.test(value))continue;
    const excerpt=value.slice(0,180);
    if(!result.includes(excerpt))result.push(excerpt);
    if(result.length>=3)break;
  }
  return result.reverse();
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
  recentCustomerMessages=[],recentStaffMessages=[],appointmentPreference="",receivedAt,now=new Date(),
  language="zh",durationMinutes=0,requireValidPreference=false}={}){
  const original=String(reply||"");
  if(!hours?.weekly)return {reply:original,blocked:false,issue:{status:"unconfigured"}};
  const bookingContext=/(?:预约|預約|约时间|約時間|安排|空档|空檔|有空|方便|可以(?:吗|嗎)|几点|幾點|几时|幾時|营业|營業|休息|开门|開門|关门|關門|\b(?:appointment|book|booking|visit|slot|available|availability|open|closed|temujanji|janji temu|pukul|boleh datang|boleh book)\b)/iu;
  const shortDay=/^(?:今天|明天|后天|後天|(?:下(?:个|個)?)?(?:星期|周|週|礼拜)[一二三四五六日天]|\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)[？?.!！。\s]*$/iu;
  const promotional=/(?:优惠|促销|价格|价钱|折扣|活动|promotion|discount|promo|price|offer|diskaun)/iu.test(customerText);
  const explicitBooking=/(?:预约|預約|约时间|約時間|安排|空档|空檔|有空|\b(?:appointment|booking|book|visit|slot|temujanji|janji temu)\b)/iu.test(customerText);
  const promotionalOnly=promotional&&!explicitBooking;
  const inboundAppointment=!promotionalOnly&&(!rejectsPreference(customerText)||parseClockPreference(customerText).times.length>0)&&(
    bookingContext.test(customerText)||timesInText(customerText).length>0||
    (String(customerText).trim().length<=25&&shortDay.test(customerText))||
    isBareCalendarPreference(customerText,localParts(receivedAt||now)?.date)||
    isBareTimePreference(customerText)||partialCalendarDay(customerText)!==null||Boolean(parseCalendar(customerText,localParts(receivedAt||now)?.date)?.invalid));
  // A spurious model booking_ready on a pricing/promotion enquiry must not
  // replace a valid price reply with an unrelated closed-day apology.
  if(rejectsPreference(customerText)&&!(parseClockPreference(customerText).rejected&&parseClockPreference(customerText).times.length)&&!claimsConfirmedAppointment(original))return {reply:original,blocked:requireValidPreference,issue:{status:"not_appointment"}};
  if(promotionalOnly&&requireValidPreference&&!claimsConfirmedAppointment(original))
    return {reply:original,blocked:true,issue:{status:"not_appointment"}};
  const issue=inboundAppointment||requireValidPreference
    ? evaluateAppointmentHours({
        hours,customerText,recentCustomerTexts,recentCustomerMessages,recentStaffMessages,
        appointmentPreference,receivedAt,now,durationMinutes,
      })
    : {status:"unknown"};
  // The response itself is a separate scheduling proposal: a customer can
  // ask "next week?" while the AI offers an invalid Monday unprompted.
  // Exclude descriptive opening-hours statements and genuine corrections.
  const replyScheduling=/(?:预约|預約|安排|有空|空档|空檔|方便|可以.*(?:来|來|过来|過來|预约|預約)|\b(?:appointment|book|booking|slot|available|visit|come|suit|work(?:s)? for you|temujanji|janji temu|boleh datang)\b)/iu;
  const closureWords=/(?:休息|不营业|不營業|没有营业|沒有營業|\bclosed\b|\btutup\b)/iu;
  const alreadyCorrects=closureWords.test(original)&&
    !/(?:今天|today|hari ini).{0,35}(?:确认|確認|check|semak|看空档|看空檔|安排)/iu.test(original);
  let outboundIssue=null;
  const outboundDates=new Set(),outboundTimes=new Set();
  const outboundRanges=[];
  let outboundDaypart=null;
  const anchor=localParts(now)?.date;
  // Keep commas and line breaks together, since date and time commonly span
  // these boundaries. A separate genuine closure statement is not an offer.
  const segments=original.split(/[。！？?!；;]|\.(?=\s+[A-Z])/u).map(x=>x.trim()).filter(Boolean)
    .flatMap(segment=>closureWords.test(segment)?segment.split(/[,，\n]|\b(?:but|however|yet|tetapi|namun)\b|但是|不过|不過|可是/u).map(x=>x.trim()):[segment]);
  const bad=["closed","past","outside_hours"];
  for(const segment of segments){
    if(closureWords.test(segment))continue;
    const parsed=parseCalendar(segment,anchor);
    const segmentClock=parseClockPreference(segment);
    const segmentTimes=segmentClock.times;
    const scheduling=replyScheduling.test(segment)||inboundAppointment||requireValidPreference;
    if(!replyScheduling.test(segment)&&/(?:promotion|promo|discount|price|offer|优惠|促销|价格|折扣|活动|diskaun)/iu.test(segment))continue;
    // A time alone in a scheduling proposal must be checked against the
    // selected date, not treated as a new, independently valid appointment.
    if(!scheduling&&!(parsed?.date&&segmentTimes.length))continue;
    if(!parsed&&!segmentTimes.length&&!replyScheduling.test(segment))continue;
    if(parsed?.invalid){outboundIssue={status:"invalid_date"};break;}
    if(segmentClock.invalid&&scheduling){outboundIssue={status:"invalid_time"};break;}
    const dates=parsed?.dates?.length?parsed.dates:
      (segmentTimes.length&&issue.date?[issue.date]:[]);
    const part=daypartInText(segment);
    for(const date of dates){
      outboundDates.add(date);
      const check=evaluateAppointmentHours({
        hours,customerText:date,receivedAt:now,now,durationMinutes,
      });
      if(bad.includes(check.status)){outboundIssue=check;break;}
      // Check ALL proposed start times, not merely one open option.
      if(segmentClock.range){
        const format=t=>{const h=Math.floor(t/60);return (h%12||12)+":"+String(t%60).padStart(2,"0")+(h>=12?" PM":" AM");};
        const checked=evaluateAppointmentHours({hours,customerText:date+" "+format(segmentClock.range[0])+" to "+format(segmentClock.range[1]),receivedAt:now,now,durationMinutes});
        if(bad.includes(checked.status)||checked.status!=="valid_preference"){outboundIssue=bad.includes(checked.status)?checked:{status:"invalid_time"};break;}
        outboundRanges.push(segmentClock.range);
      }
      for(const t of segmentClock.range?[]:segmentTimes){
        const h=Math.floor(t/60);
        const time=(h%12||12)+":"+String(t%60).padStart(2,"0")+(h>=12?" PM":" AM");
        const inspected=evaluateAppointmentHours({hours,customerText:date+" "+time,
          receivedAt:now,now,durationMinutes});
        if(bad.includes(inspected.status)){outboundIssue=inspected;break;}
      }
      if(outboundIssue)break;
      if(!segmentTimes.length&&part){
        const inspected=evaluateAppointmentHours({hours,customerText:date+" "+part,receivedAt:now,now,durationMinutes});
        if(bad.includes(inspected.status)){outboundIssue=inspected;break;}
      }
    }
    if(outboundIssue)break;
    for(const t of segmentClock.range?[]:segmentTimes)outboundTimes.add(t);
    if(part)outboundDaypart=part;
  }
  const lang=String(language||"zh").toLowerCase().slice(0,2);
  const acknowledgement=()=>{
    const date=issue.date;
    const pref=verifiedAppointmentPreference(issue);
    const clockValues=issue.range||issue.times;
    const clock=clockValues?.length?clockValues.map(t=>{
      const h=Math.floor(t/60);
      return (h%12||12)+":"+String(t%60).padStart(2,"0")+(h>=12?" PM":" AM");
    }).join(issue.range?" – ":" / "):null;
    const parts={morning:["morning","pagi","上午"],noon:["around noon","tengah hari","中午"],
      afternoon:["afternoon","petang","下午"],evening:["evening","malam","晚上"],overnight:["overnight","awal pagi","凌晨"]};
    const time=clock||parts[issue.daypart]?.[lang==="en"?0:lang==="ms"?1:2]||"";
    if(!pref)return original;
    if(lang==="en")return "Thank you 😊 I'll check your preferred date and time ("+date+", "+time+") with the clinic and get back to you once confirmed.";
    if(lang==="ms")return "Terima kasih 😊 Kami akan semak pilihan anda ("+date+", "+time+") dengan pusat dan maklumkan selepas disahkan.";
    return "好的亲爱的 😊 我帮您向诊所确认您选择的日期和时间（"+date+" "+time+"），确认后再回复您哦。";
  };
  const redundant=asksSchedulingQuestion(original);
  const falseConfirmation=claimsConfirmedAppointment(original);
  const mismatch=issue.status==="valid_preference"&&(
    [...outboundDates].some(d=>d!==issue.date)||
    (outboundTimes.size>0&&(!issue.times?.length||[...outboundTimes].some(t=>!issue.times.includes(t))))||
    outboundRanges.some(range=>!issue.range||range[0]!==issue.range[0]||range[1]!==issue.range[1])||
    (outboundDaypart&&issue.daypart&&outboundDaypart!==issue.daypart));
  // If the customer preference is valid, do not replace it with an invalid or
  // invented model suggestion. Preserve Booking Ready and acknowledge the
  // verified preference instead. Do not override genuine closure explanations.
  if(issue.status==="valid_preference"&&(requireValidPreference||inboundAppointment)&&
    (redundant||falseConfirmation||(requireValidPreference&&(mismatch||outboundIssue))||(!outboundIssue&&mismatch))){
    return {reply:acknowledgement(),blocked:false,issue,repairedPreference:true,redundantClarification:redundant};
  }
  const invalid=["closed","past","outside_hours"];
  const conflict=invalid.includes(issue.status)?issue:
    outboundIssue&&invalid.includes(outboundIssue.status)?outboundIssue:null;
  if(conflict){
    return {reply:alreadyCorrects&&issue.status==="closed"&&!outboundIssue?original:
      issueReply(conflict,{hours,language}),blocked:true,issue:conflict};
  }
  if(falseConfirmation){
    const safe=lang==="en"?"Our team needs to check availability before confirming any appointment.":lang==="ms"?"Pihak pusat perlu semak kekosongan sebelum janji temu disahkan.":"预约需要由门店同事核实空档后才能确认哦。";
    return {reply:safe,blocked:true,issue:{status:"unverified_confirmation"}};
  }
  if(["invalid_date","invalid_time"].includes(outboundIssue?.status)&&!requireValidPreference){
    return {reply:lang==="en"?"Which date would suit you?":lang==="ms"?"Tarikh mana yang sesuai?":"请问哪一天方便呢？",blocked:true,issue:outboundIssue};
  }
  if((requireValidPreference||(inboundAppointment&&redundant))&&["unknown","ambiguous","invalid_date","unconfigured","valid_day"].includes(issue.status)){
    const lang=String(language||"zh").toLowerCase().slice(0,2);
    const needsOnlyTime=issue.status==="valid_day";
    const needsOnlyDate=["unknown","ambiguous","invalid_date"].includes(issue.status)&&issue.hasTime;
    const question=needsOnlyTime
      ? lang==="en"?"What time on that day would suit you? I can check with the clinic 😊"
        : lang==="ms"?"Pukul berapa pada hari itu yang sesuai? Kami boleh semak dengan pusat 😊"
        : "那一天大概几点方便呢？我帮您向诊所确认空档哦☺️"
      : needsOnlyDate
        ? lang==="en"?"Which date would suit you? I'll check with the clinic 😊"
          : lang==="ms"?"Tarikh mana yang sesuai? Kami boleh semak dengan pusat 😊"
          : "请问您哪一天方便呢？我帮您向诊所确认空档哦☺️"
        : lang==="en"?"Which date and time would you prefer? I'll have the clinic check availability 😊":
        lang==="ms"?"Tarikh dan masa mana yang sesuai? Kami boleh semak kekosongan dahulu 😊":
        "请问您想预约哪一天、几点呢？我帮您向诊所确认空档哦☺️";
    return {reply:question,blocked:true,issue};
  }
  return {reply:original,blocked:false,issue};
}

function describeWeeklyHours(hours){
  if(!hours?.weekly)return null;
  const weekly=hours.weekly;
  const ranges=[];
  const closed=[];
  for(const d of ["monday","tuesday","wednesday","thursday","friday","saturday","sunday"]){
    const index=DAYS.indexOf(d);
    const slots=intervals(hours,index);
    if(slots===null)throw new Error("Invalid opening hours for "+d);
    if(!slots.length){closed.push(d.charAt(0).toUpperCase()+d.slice(1));continue;}
    const clock=m=>{
      const h=Math.floor(m/60),min=m%60;
      return (h%12||12)+(min?":"+String(min).padStart(2,"0"):"")+(h>=12?"pm":"am");
    };
    ranges.push(d.charAt(0).toUpperCase()+d.slice(1)+" "+slots.map(
      ([from,to])=>clock(from)+"-"+clock(to)).join(", "));
  }
  return {general:ranges.join("; "),closed:closed.length?"Closed: "+closed.join(", "):"No weekly closed days"};
}
function currentClinicDate(value=new Date()){
  const p=localParts(value);
  return p?DAYS[p.weekday]+", "+p.date+" "+
    String(Math.floor(p.minute/60)).padStart(2,"0")+":"+
    String(p.minute%60).padStart(2,"0")+" ("+ZONE+")":"Malaysia time unavailable";
}
module.exports={ZONE,localParts,detectDate,intervals,timesInText,
  durationMinutesForPackage,evaluateAppointmentHours,issueReply,
  guardAppointmentReply,currentClinicDate,describeWeeklyHours,durationFromText,verifiedAppointmentPreference,canRecoverBookingReady,parseClockPreference,claimsConfirmedAppointment,appointmentCustomerContext};
