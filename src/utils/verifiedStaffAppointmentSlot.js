"use strict";
const {detectDate,localParts,parseClockPreference,intervals}=require("./appointmentHoursGuard");
function verifiedStaffSlot(text,sourceAt,now=sourceAt,hours,{allowUnconfigured=false}={}){
 const anchor=localParts(sourceAt);
 if(!anchor)return null;
 const date=detectDate(text,anchor.date);
 const clock=parseClockPreference(text);
 if(!date?.date||date.ambiguous||clock.invalid||clock.range||clock.times.length!==1)return null;
 const minute=clock.times[0];
 const instant=Date.parse(date.date+"T00:00:00+08:00")+minute*60000;
 if(!Number.isFinite(instant)||instant<=new Date(now).getTime())return null;
 const open=intervals(hours,new Date(date.date+"T12:00:00Z").getUTCDay());
 if(open===null&&!allowUnconfigured||open!==null&&!open.some(([a,b])=>minute>=a&&minute<b))return null;
 return new Date(instant).toISOString();
}
module.exports={verifiedStaffSlot};
