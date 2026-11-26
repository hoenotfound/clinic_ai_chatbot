"use strict";
const {detectDate,localParts,parseClockPreference,intervals}=require("./appointmentHoursGuard");
function verifiedStaffSlot(text,sourceAt,now=sourceAt,hours,{allowUnconfigured=false}={}){
 const anchor=localParts(sourceAt);
 if(!anchor)return null;
 const date=detectDate(text,anchor.date);
 // Mask numeric calendar spans before reading clocks: "24/11-12pm"
 // contains a date followed by a time, not an 11-to-12 time range.
 const clockText=String(text||"").normalize("NFKC")
   .replace(/\b20\d{2}[/-]\d{1,2}[/-]\d{1,2}\b/gu,m=>" ".repeat(m.length))
   .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]20\d{2})?\b/gu,m=>" ".repeat(m.length));
 const clock=parseClockPreference(clockText);
 if(!date?.date||date.ambiguous||clock.invalid||clock.range||clock.times.length!==1)return null;
 const minute=clock.times[0];
 const instant=Date.parse(date.date+"T00:00:00+08:00")+minute*60000;
 if(!Number.isFinite(instant)||instant<=new Date(now).getTime())return null;
 const open=intervals(hours,new Date(date.date+"T12:00:00Z").getUTCDay());
 if(open===null&&!allowUnconfigured||open!==null&&!open.some(([a,b])=>minute>=a&&minute<b))return null;
 return new Date(instant).toISOString();
}
module.exports={verifiedStaffSlot};
