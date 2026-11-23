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
  if(!anchorDate || !/^\d{4}-\d{2}-\d{2}$/.test(anchorDate))return null;
  const found=new Set();
  const add=(v)=>{if(v)found.add(v);};
  for(const m of source.matchAll(/\b(20\d{2})[/-](\d{1,2})[/-](\d{1,2})\b/gu))
    add(validDate(+m[1],+m[2],+m[3]));
  for(const m of source.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](20\d{2}))?\b/gu)){
    if(m.index>0&&/[\d/-]/u.test(source[m.index-1]))continue;
    const year=m[3]?+m[3]:+anchorDate.slice(0,4);
    let date=validDate(year,+m[2],+m[1]);
    if(!m[3]&&date&&date<anchorDate)date=validDate(year+1,+m[2],+m[1]);
    add(date);
  }
  for(const m of source.matchAll(/(\d{1,2})月(\d{1,2})[日号號]?/gu)){
    const year=+anchorDate.slice(0,4);
    let date=validDate(year,+m[1],+m[2]);
    if(date&&date<anchorDate)date=validDate(year+1,+m[1],+m[2]);
    add(date);
  }
  for(const [pattern,offset] of [
    [/(?:今天|今日|\btoday\b|\bhari ini\b)/iu,0],
    [/(?:明天|\btomorrow\b|\besok\b)/iu,1],
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
    add(plusDays(anchorDate,distance));
  }
  for(let d=0;d<WEEK_ALIASES.length;d++){
    const pattern=new RegExp("\\b(?:(next|this|coming)\\s+)?(?:"+WEEK_ALIASES[d].join("|")+")\\b","giu");
    for(const m of source.matchAll(pattern)){
      let distance=(d-weekday(anchorDate)+7)%7;
      if(m[1]==="next")distance=7-(weekday(anchorDate)+6)%7+(d+6)%7;
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
    /(?:上午|早上|凌晨|\bmorning\b|\bpagi\b)/iu.test(value)?"am":"";
  const results=new Set();
  function addTime(hour,minute,suffix=""){
    if(!Number.isInteger(hour)||hour<0||hour>23||minute<0||minute>59)return;
    const marker=String(suffix||period).toLowerCase();
    if(marker==="pm"&&hour>0&&hour<12)hour+=12;
    if(marker==="am"&&hour===12)hour=0;
    if(!marker&&hour>0&&hour<8)return; // ambiguous "2点" without daypart
    results.add(hour*60+minute);
  }
  const chineseDigits={"零":0,"〇":0,"一":1,"二":2,"两":2,"兩":2,"三":3,"四":4,
    "五":5,"六":6,"七":7,"八":8,"九":9,"十":10};
  function chineseNumber(input){
    if(/^\d{1,2}$/.test(input))return +input;
    if(input==="十")return 10;
    if(input.startsWith("十"))return 10+(chineseDigits[input.slice(1)]||0);
    if(input.endsWith("十"))return (chineseDigits[input.slice(0,-1)]||0)*10;
    if(input.includes("十")){
      const [a,b]=input.split("十");
      return (chineseDigits[a]||0)*10+(chineseDigits[b]||0);
    }
    return Object.prototype.hasOwnProperty.call(chineseDigits,input)?chineseDigits[input]:null;
  }
  for(const m of value.matchAll(/([零〇一二两兩三四五六七八九十\d]{1,3})\s*(?:点|點|时|時)(?:\s*([零〇一二两兩三四五六七八九十\d]{1,3})\s*分?)?/gu)){
    const h=chineseNumber(m[1]);
    const min=m[2]?chineseNumber(m[2]):0;
    if(h!==null&&min!==null)addTime(h,min);
  }
  for(const m of value.matchAll(/(?:^|[^\d])(\d{1,2})[:.：](\d{2})(?:\s*(a\.?m\.?|p\.?m\.?))?(?!\d)/giu)){
    const suffix=String(m[3]||"").toLowerCase().replace(/\./g,"");
    addTime(+m[1],+m[2],suffix);
  }
  for(const m of value.matchAll(/\b(\d{1,2})\s*(a\.?m\.?|p\.?m\.?)\b/giu)){
    addTime(+m[1],0,m[2].toLowerCase().replace(/\./g,""));
  }
  for(const m of value.matchAll(/\b(?:pukul\s*)?(\d{1,2})\s*(?:pagi|petang|malam|tengah hari)\b/giu)){
    const suffix=/petang|malam|tengah hari/iu.test(m[0])?"pm":"am";
    addTime(+m[1],0,suffix);
  }
  return [...results];
}

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
  recentCustomerMessages=[],appointmentPreference="",receivedAt=new Date(),now=new Date(),
  durationMinutes=0,trustPreferenceWithoutCustomer=false}={}){
  if(!hours?.weekly)return {status:"unconfigured"};
  const anchor=localParts(receivedAt),today=localParts(now);
  if(!anchor||!today)return {status:"unknown"};
  const current=detectDate(customerText,anchor.date);
  if(current?.ambiguous)return {status:"ambiguous"};
  let selected=current?.date||null;
  if(!selected){
    // Only inherit an earlier customer-selected day inside this conversation's
    // recent scheduling window. Never reinterpret an older "today" as today.
    const history=recentCustomerMessages.length?recentCustomerMessages:
      recentCustomerTexts.map(content=>({content,createdAt:receivedAt}));
    for(const item of history){
      const content=typeof item==="string"?item:String(item?.content||"");
      const at=typeof item==="string"?receivedAt:
        (item.createdAt||item.created_at||item.pricingCreatedAtMs||null);
      const timestamp=new Date(at).getTime();
      if(!Number.isFinite(timestamp)||timestamp>Date.parse(now)+120000||
         Date.parse(now)-timestamp>36*3600000)continue;
      const visitIntent=/(?:预约|預約|安排|过来|過來|来店|來店|有空|方便|可以(?:吗|嗎)|几点|幾點|几时|幾時|\b(?:appointment|booking|book|visit|slot|available|come|temujanji|janji temu)\b)/iu;
      const bareDate=/^(?:今天|明天|后天|後天|(?:下(?:个|個)?)?(?:星期|周|週|礼拜)[一二三四五六日天]|today|tomorrow|(?:next )?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))[？?.!！。\s]*$/iu;
      if(!visitIntent.test(content)&&!bareDate.test(content))continue;
      if(/(?:优惠|促销|价格|价钱|活动|promotion|discount|promo|price|offer|diskaun)/iu.test(content)&&
         !/(?:预约|預約|\b(?:appointment|book|visit)\b)/iu.test(content))continue;
      const local=localParts(timestamp);
      if(!local)continue;
      const found=detectDate(content,local.date);
      if(found?.ambiguous)return {status:"ambiguous"};
      if(found?.date&&found.date>=today.date){selected=found.date;break;}
      // A past relative day must be clarified, not silently re-dated.
      if(found?.date&&found.date<today.date)return {status:"unknown"};
    }
  }
  // Model-provided preference is untrusted unless grounded by the customer's
  // own dated message. Only callers with independently verified preferences
  // can opt into interpreting preference alone.
  if(!selected&&trustPreferenceWithoutCustomer){
    const found=detectDate(appointmentPreference,anchor.date);
    if(found?.ambiguous)return {status:"ambiguous"};
    selected=found?.date||null;
  }
  if(!selected)return {status:"unknown"};
  const day=weekday(selected),opening=intervals(hours,day);
  const info={date:selected,weekday:day};
  if(opening===null)return {status:"unconfigured",...info};
  if(!opening.length)return {status:"closed",...info};
  if(selected<today.date)return {status:"past",...info};
  let times=timesInText(customerText);
  if(!times.length)times=timesInText(appointmentPreference);
  if(!times.length){
    const daypart=/(?:上午|早上|中午|下午|晚上|傍晚|凌晨|morning|afternoon|evening|pagi|petang|malam|tengah hari)/iu;
    const currentDaypart=daypart.test(customerText);
    const recentDaypart=recentCustomerMessages.some(item=>{
      const at=new Date(item?.createdAt||item?.created_at||item?.pricingCreatedAtMs).getTime();
      return Number.isFinite(at)&&at<=new Date(now).getTime()+120000&&
        new Date(now).getTime()-at<=36*3600000&&daypart.test(String(item?.content||""));
    });
    return {status:currentDaypart||recentDaypart?"valid_preference":"valid_day",...info};
  }
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
  recentCustomerMessages=[],appointmentPreference="",receivedAt,now=new Date(),
  language="zh",durationMinutes=0,requireValidPreference=false}={}){
  const original=String(reply||"");
  if(!hours?.weekly)return {reply:original,blocked:false,issue:{status:"unconfigured"}};
  const bookingContext=/(?:预约|預約|约时间|約時間|安排|空档|空檔|有空|方便|可以(?:吗|嗎)|几点|幾點|几时|幾時|营业|營業|休息|开门|開門|关门|關門|\b(?:appointment|book|booking|visit|slot|available|availability|open|closed|temujanji|janji temu|pukul|boleh datang|boleh book)\b)/iu;
  const shortDay=/^(?:今天|明天|后天|後天|(?:下(?:个|個)?)?(?:星期|周|週|礼拜)[一二三四五六日天]|\b(?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b)[？?.!！。\s]*$/iu;
  const promotional=/(?:优惠|促销|价格|价钱|折扣|活动|promotion|discount|promo|price|offer|diskaun)/iu.test(customerText);
  const explicitBooking=/(?:预约|預約|约时间|約時間|安排|空档|空檔|有空|\b(?:appointment|booking|book|visit|slot|temujanji|janji temu)\b)/iu.test(customerText);
  const promotionalOnly=promotional&&!explicitBooking;
  const inboundAppointment=!promotionalOnly&&(
    bookingContext.test(customerText)||timesInText(customerText).length>0||
    (String(customerText).trim().length<=25&&shortDay.test(customerText)));
  // A spurious model booking_ready on a pricing/promotion enquiry must not
  // replace a valid price reply with an unrelated closed-day apology.
  if(promotionalOnly&&requireValidPreference)
    return {reply:original,blocked:true,issue:{status:"not_appointment"}};
  const issue=inboundAppointment||requireValidPreference
    ? evaluateAppointmentHours({
        hours,customerText,recentCustomerTexts,recentCustomerMessages,
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
  // Validate each positive suggestion independently. "Monday is closed,
  // Tuesday?" must be allowed, but "Monday or Tuesday?" is unsafe.
  const segments=original.split(/[\n。！？?!，,；;]/u).map(s=>s.trim()).filter(Boolean);
  for(const segment of segments){
    if(closureWords.test(segment)||!replyScheduling.test(segment))continue;
    const anchor=localParts(now)?.date;
    const date=detectDate(segment,anchor);
    if(date?.date){
      const inspected=evaluateAppointmentHours({
        hours,customerText:segment,receivedAt:now,now,durationMinutes,
      });
      if(["closed","past","outside_hours"].includes(inspected.status)){
        outboundIssue=inspected;break;
      }
    }else if(date?.ambiguous){
      // Multiple date alternatives in one proposal. Evaluate each weekday
      // separately, not as one arbitrary selected date.
      const options=[
        ...(segment.match(/(?:下(?:个|個)?)?(?:星期|周|週|礼拜|禮拜)[一二三四五六日天]/gu)||[]),
        ...(segment.match(/\b(?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/giu)||[]),
      ];
      for(const option of options){
        const result=evaluateAppointmentHours({
          hours,customerText:option,receivedAt:now,now,durationMinutes,
        });
        if(["closed","past","outside_hours"].includes(result.status)){
          outboundIssue=result;break;
        }
      }
      if(outboundIssue)break;
    }
  }
  // One unsplit, natural standalone suggestion can be just "Monday 2pm".
  if(!outboundIssue&&replyScheduling.test(original)&&segments.length===1){
    const date=detectDate(original,localParts(now)?.date);
    if(date?.date){
      const inspected=evaluateAppointmentHours({
        hours,customerText:original,receivedAt:now,now,durationMinutes,
      });
      if(["closed","past","outside_hours"].includes(inspected.status))
        outboundIssue=inspected;
    }
  }
  const invalid=["closed","past","outside_hours"];
  const conflict=invalid.includes(issue.status)?issue:
    outboundIssue&&invalid.includes(outboundIssue.status)?outboundIssue:null;
  if(conflict){
    return {reply:alreadyCorrects&&issue.status==="closed"?original:
      issueReply(conflict,{hours,language}),blocked:true,issue:conflict};
  }
  if(requireValidPreference&&["unknown","ambiguous","unconfigured","valid_day"].includes(issue.status)){
    const lang=String(language||"zh").toLowerCase().slice(0,2);
    const question=lang==="en"?"Which date and time would you prefer? I'll have the clinic check availability 😊":
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
  guardAppointmentReply,currentClinicDate,describeWeeklyHours,durationFromText};
