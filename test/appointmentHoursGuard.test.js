"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const {
  localParts, detectDate, evaluateAppointmentHours, guardAppointmentReply,
  durationMinutesForPackage, currentClinicDate, timesInText, describeWeeklyHours,
} = require("../src/utils/appointmentHoursGuard");
const { createBookingReadyOutcomeService } = require("../src/services/bookingReadyOutcomeService");

const hours = {
  general: "Tuesday–Friday 10am–8pm; Saturday–Sunday 10am–6pm",
  closed: "Monday closed",
  weekly: {
    monday: null,
    tuesday: { open: "10:00", close: "20:00" },
    wednesday: { open: "10:00", close: "20:00" },
    thursday: { open: "10:00", close: "20:00" },
    friday: { open: "10:00", close: "20:00" },
    saturday: { open: "10:00", close: "18:00" },
    sunday: { open: "10:00", close: "18:00" },
  },
};
const monday = "2026-11-23T04:43:35.255Z"; // 12:43 PM Malaysia time
const laterMonday = "2026-11-23T04:43:42.000Z";

test("clinic date is explicitly Asia/Kuala_Lumpur, including midnight boundary", () => {
  assert.deepEqual(localParts(monday), { date: "2026-11-23", weekday: 1, minute: 12 * 60 + 43 });
  assert.equal(localParts("2026-11-22T16:01:00Z").date, "2026-11-23");
  assert.match(currentClinicDate(monday), /monday, 2026-11-23 12:43 \(Asia\/Kuala_Lumpur\)/);
});

test("customer #9283 today, then 1pm or 2pm, cannot create a Monday appointment", () => {
  const args = {
    hours,
    customerText: "下午1点或2点都可以",
    recentCustomerTexts: ["今天可以吗", "你好～我想选择 Package A，请问可以安排预约吗？"],
    appointmentPreference: "今天 下午1点或2点",
    receivedAt: monday,
    now: laterMonday,
  };
  const evaluated = evaluateAppointmentHours(args);
  assert.equal(evaluated.status, "closed");
  assert.equal(evaluated.date, "2026-11-23");
  const checked = guardAppointmentReply({
    ...args, reply: "我马上帮你看中医师今天的空档，确认后回复哦 😊", language: "zh",
  });
  assert.equal(checked.blocked, true);
  assert.match(checked.reply, /星期一是休息日/);
  assert.match(checked.reply, /星期二/);
  assert.doesNotMatch(checked.reply, /今天的空档/);
});

test("short 2pm reply inherits the previously requested Monday", () => {
  const checked = guardAppointmentReply({
    hours, customerText:"2pm", recentCustomerTexts:["今天可以吗"],
    appointmentPreference:"今天 2pm",
    reply:"Okay, I will check today's 2pm slot 😊",
    receivedAt:monday, now:laterMonday, language:"en",
  });
  assert.equal(checked.blocked,true);
  assert.match(checked.reply,/closed on monday/i);
});

test("closed day is recognized across Chinese, English and Malay", () => {
  const cases = ["下星期一下午2点", "next Monday 2pm", "Hari Isnin pukul 14:00"];
  for (const text of cases) {
    assert.equal(evaluateAppointmentHours({
      hours, customerText: text, receivedAt: monday, now: laterMonday,
    }).status, "closed", text);
  }
  for (const lang of ["zh", "en", "ms"]) {
    const checked = guardAppointmentReply({
      hours, customerText: "今天可以吗", reply: "Yes, today is fine",
      receivedAt: monday, now: laterMonday, language: lang,
    });
    assert.equal(checked.blocked, true);
    assert.ok(checked.reply.length > 20);
  }
});

test("a Monday promotion question stays a promotion question", () => {
  const original = "本月骨盆调理有 Package A 和 Package B 优惠哦 😊";
  for (const question of ["今天有什么优惠？", "今天骨盆调理价格多少？", "今天 RM68 活动还有吗？"]) {
    const checked = guardAppointmentReply({
      hours, customerText: question, reply: original,
      receivedAt: monday, now: laterMonday,
    });
    assert.equal(checked.blocked, false, question);
    assert.equal(checked.reply, original, question);
  }
});

test("open days are valid preferences, NOT evidence of an available slot", () => {
  for (const text of ["明天下午2点", "Tuesday 2pm", "Selasa 14:00"]) {
    const result = evaluateAppointmentHours({hours,customerText:text,receivedAt:monday,now:laterMonday});
    assert.equal(result.status, "valid_preference", text);
  }
  const checked = guardAppointmentReply({
    hours, customerText:"明天下午2点",
    reply:"星期二下午2点我帮您向诊所查询是否有空档 😊",
    receivedAt:monday,now:laterMonday,
  });
  assert.equal(checked.blocked,false);
});

test("late opening hours, elapsed times and duration all reject invalid slots", () => {
  const saturday = "2026-11-28T07:00:00Z"; // 3pm MYT
  assert.equal(evaluateAppointmentHours({
    hours,customerText:"今天晚上7点",receivedAt:saturday,now:saturday,
  }).status,"outside_hours");
  assert.equal(evaluateAppointmentHours({
    hours,customerText:"今天下午5点",receivedAt:saturday,now:saturday,
    durationMinutes:150,
  }).status,"outside_hours");
  assert.equal(evaluateAppointmentHours({
    hours,customerText:"今天下午4点",receivedAt:saturday,now:saturday,
    durationMinutes:90,
  }).status,"valid_preference");
  assert.equal(evaluateAppointmentHours({
    hours,customerText:"今天下午1点",receivedAt:saturday,
    now:"2026-11-28T08:00:00Z",
  }).status,"past");
});

test("next-week Chinese dates resolve to the following calendar week", () => {
  assert.equal(detectDate("下星期一下午2点", "2026-11-23").date, "2026-11-30");
  assert.equal(detectDate("下星期二下午2点", "2026-11-23").date, "2026-12-01");
  assert.equal(detectDate("下星期日", "2026-11-23").date, "2026-12-06");
});

test("ambiguous alternative days fail closed for booking-ready without choosing one", () => {
  assert.equal(detectDate("星期一或星期二", "2026-11-23").ambiguous,true);
  assert.equal(evaluateAppointmentHours({
    hours, customerText:"星期一或星期二", receivedAt:monday,now:laterMonday,
  }).status,"ambiguous");
  assert.equal(evaluateAppointmentHours({
    hours:{general:"Mon-Fri"}, customerText:"今天下午2点",
    receivedAt:monday,now:laterMonday,
  }).status,"unconfigured");
});

test("duration comes from the selected configured package, not a hardcoded Neutro switch", () => {
  const duration = durationMinutesForPackage({
    config:{promotions:[{linkedService:"骨盆调理",packages:[
      {name:"Package A",caption:"尊享护理配套｜2小时30分钟"},
      {name:"Package B",caption:"女性护理配套 60分钟"},
    ]}]},
    customerTexts:["我想选择 Package A"],
    treatment:"骨盆调理",
  });
  assert.equal(duration,150);
});

test("a valid correction from the model is kept natural but never booking-ready", () => {
  const text="不好意思，星期一我们休息哦💚 星期二方便吗？";
  const result=guardAppointmentReply({
    hours,customerText:"今天可以吗",reply:text,
    receivedAt:monday,now:laterMonday,
  });
  assert.equal(result.blocked,true);
  assert.equal(result.reply,text);
});


test("AI suggestions of Monday are checked even without customer selecting Monday", () => {
  const checked = guardAppointmentReply({
    hours, customerText:"Can I visit next week?",
    reply:"Sure, would Monday afternoon 2pm work for you? 😊",
    receivedAt:monday, now:laterMonday, language:"en",
  });
  assert.equal(checked.blocked,true);
  assert.equal(checked.issue.status,"closed");
  assert.match(checked.reply,/closed on monday/i);
  assert.doesNotMatch(checked.reply,/Monday afternoon 2pm work/i);
});
test("AI already correcting Monday remains natural without Booking Ready", () => {
  const reply="我们星期一休息哦，星期二下午两点方便吗？";
  const checked=guardAppointmentReply({
    hours,customerText:"今天可以吗",reply,
    receivedAt:monday,now:laterMonday,
  });
  assert.equal(checked.blocked,true);
  assert.equal(checked.reply,reply);
});
test("seven in the evening and Malay pukul tujuh are recognized as 7 PM", () => {
  const saturday="2026-11-28T07:00:00Z";
  for (const text of ["星期六晚上七点", "Saturday pukul 7 malam", "Saturday 7.00pm", "星期六晚上7点"]) {
    assert.equal(evaluateAppointmentHours({
      hours,customerText:text,receivedAt:saturday,now:saturday,
    }).status,"outside_hours",text);
  }
  assert.ok(timesInText("星期六晚上七点").includes(19*60));
  assert.ok(timesInText("pukul 7 malam").includes(19*60));
});
test("an older 'today' is anchored to original timestamp and never silently reused", () => {
  const tuesday="2026-11-24T06:00:00Z";
  const history=[{content:"今天可以吗",createdAt:monday}];
  const result=evaluateAppointmentHours({
    hours,customerText:"2pm",recentCustomerMessages:history,
    appointmentPreference:"今天 2pm",receivedAt:tuesday,now:tuesday,
  });
  assert.equal(result.status,"unknown");
  const checked=guardAppointmentReply({
    hours,customerText:"2pm",recentCustomerMessages:history,
    appointmentPreference:"今天 2pm",reply:"I'll check that time for you",
    receivedAt:tuesday,now:tuesday,language:"en",requireValidPreference:true,
  });
  assert.equal(checked.blocked,true);
  assert.match(checked.reply,/Which date/i);
});
test("same-day dated conversation stays available to a terse later time", () => {
  const checked=guardAppointmentReply({
    hours,customerText:"2pm",
    recentCustomerMessages:[{content:"今天可以吗",createdAt:monday}],
    reply:"I'll check today's slot for you",
    receivedAt:laterMonday,now:laterMonday,language:"en",
  });
  assert.equal(checked.blocked,true);
  assert.equal(checked.issue.status,"closed");
});
test("customer has a valid Tuesday preference but AI suggests closed Monday", () => {
  const tuesday="2026-11-24T03:00:00Z";
  const checked=guardAppointmentReply({
    hours,customerText:"Tuesday afternoon",
    reply:"Would next Monday 2pm suit you for the visit?",
    receivedAt:monday,now:monday,language:"en",
  });
  assert.equal(checked.blocked,true);
  assert.equal(checked.issue.status,"closed");
  assert.ok(checked.reply.includes("monday"));
  assert.ok(tuesday);
});
test("treatment duration fallback is read from configured service, not assumed from basic pelvic care", () => {
  const duration=durationMinutesForPackage({
    config:{services:[{name:"9D 逆龄抗衰",duration:"约2小时"}]},
    customerTexts:["9D 逆龄抗衰"],treatment:"9D 逆龄抗衰",
  });
  assert.equal(duration,120);
  const combined=durationMinutesForPackage({
    config:{services:[{name:"3D + 9D 组合",duration:""}]},
    customerTexts:["3D + 9D 组合"],treatment:"3D + 9D 组合",
  });
  assert.equal(combined,0);
});
test("weekly hours produce consistent public descriptions and reject malformed schedules", () => {
  const text=describeWeeklyHours(hours);
  assert.match(text.general,/Tuesday 10am-8pm/);
  assert.match(text.general,/Saturday 10am-6pm/);
  assert.match(text.closed,/Monday/);
  const altered=structuredClone(hours);
  altered.weekly.tuesday={open:"20:00",close:"10:00"};
  assert.throws(()=>describeWeeklyHours(altered),/Invalid opening hours for tuesday/);
});
test("the final follow-up step checks invalid promotional appointment proposals", () => {
  const checked=guardAppointmentReply({
    hours,customerText:"",
    reply:"本月活动还在进行哦，星期一下午2点方便过来预约吗？",
    receivedAt:monday,now:laterMonday,language:"zh",
  });
  assert.equal(checked.blocked,true);
  assert.equal(checked.issue.status,"closed");
  assert.doesNotMatch(checked.reply,/本月活动还在进行/);
});


test("Booking Ready requires a customer-provided time or daypart", async () => {
  const dateOnly=evaluateAppointmentHours({
    hours,customerText:"明天可以预约吗？",receivedAt:monday,now:laterMonday,
    appointmentPreference:"明天 2pm",
  });
  assert.equal(dateOnly.status,"valid_day");
  const withDaypart=evaluateAppointmentHours({
    hours,customerText:"明天下午方便",receivedAt:monday,now:laterMonday,
    appointmentPreference:"明天下午",
  });
  assert.equal(withDaypart.status,"valid_preference");
  const checked=guardAppointmentReply({
    hours,customerText:"明天可以预约吗？",
    reply:"好的，我们帮您确认2pm",appointmentPreference:"明天2pm",
    receivedAt:monday,now:laterMonday,requireValidPreference:true,
  });
  assert.equal(checked.blocked,true);
  assert.match(checked.reply,/那一天大概几点/);
});
test("the most recent pelvic package wins over an older package in chat history", () => {
  const config={promotions:[{linkedService:"骨盆调理",packages:[
    {name:"Package A",caption:"2小时30分钟"},
    {name:"Package B",caption:"60分钟"},
  ]}]};
  assert.equal(durationMinutesForPackage({
    config,customerTexts:["我选 Package B","我之前看过 Package A"],
    treatment:"骨盆调理",
  }),60);
});

test("booking-ready backstop rejects the closed day BEFORE any database mutation", async () => {
  const originalHours=config.hours;
  const originalType=config.businessType;
  config.hours=hours;
  config.businessType="tcm_clinic";
  let connects=0, alerts=0;
  try {
    const mark=createBookingReadyOutcomeService({
      database:{async connect(){connects++;throw Error("must not connect");}},
      now:()=>new Date(laterMonday),
      publish(){throw Error("must not publish");},
      sendBookingReadyAlert(){alerts++;throw Error("must not alert");},
    });
    // Keep receipt, customer evidence and service clock on the SAME
    // simulated Monday. Mixing real wall time with a frozen service clock
    // makes trusted history appear to come from the future.
    const date=localParts(monday).date;
    const result=await mark(9283,23208,{
      details:{appointmentPreference:date+" 下午1点或2点"},
      customerText:"下午1点或2点都可以",
      recentCustomerMessages:[{content:date,createdAt:monday}],
      receivedAt:laterMonday,
    });
    assert.equal(result.contactUpdated,false);
    assert.equal(result.blockedReason,"closed");
    assert.equal(connects,0);
    assert.equal(alerts,0);
  } finally {
    config.hours=originalHours;
    config.businessType=originalType;
  }
});

test("written English and Malay calendar dates, including the original newline format", () => {
  const now="2026-11-23T23:20:35.826Z";
  for(const customerText of ["29th November \n3.00 PM","29 November 3.00 PM",
    "November 29 at 3pm","29 Nov, 2026 3:00 PM","29 November pukul 3 petang",
    "2026年11月29日 下午3点"]){
    const result=evaluateAppointmentHours({hours,customerText,receivedAt:now,now});
    assert.equal(result.date,"2026-11-29",customerText);
    assert.equal(result.status,"valid_preference",customerText);
  }
  assert.equal(detectDate("5 Disember 2026","2026-11-24").date,"2026-12-05");
  assert.equal(detectDate("1 Mac 2027","2026-11-24").date,"2027-03-01");
  assert.equal(detectDate("November 29, 2026","2026-11-24").date,"2026-11-29");
  assert.equal(detectDate("day after tomorrow","2026-11-24").date,"2026-11-26");
  assert.equal(detectDate("Next Monday","2026-11-23").date,"2026-11-30");
  assert.equal(detectDate("29 November or 30 November","2026-11-24").ambiguous,true);
  assert.equal(detectDate("31 November","2026-11-24"),null);
  assert.deepEqual(timesInText("3:11 PM"),[15*60+11]);
});
test("a natural written date and separate clock time are joined from timestamped customer evidence", () => {
  const now="2026-11-23T23:48:20Z";
  for(const content of ["29 November","29th November","29/11","2026-11-29","11月29日","Ahad"]){
    const args={hours,customerText:"3.00 PM",
      recentCustomerMessages:[{content,createdAt:"2026-11-23T23:48:15Z"}],
      receivedAt:now,now};
    const result=evaluateAppointmentHours(args);
    assert.equal(result.status,"valid_preference",content);
    assert.equal(result.date,"2026-11-29",content);
    const reply="Sunday at 3 PM, I'll check availability with our team 😊";
    const checked=guardAppointmentReply({...args,reply,language:"en",requireValidPreference:true});
    assert.equal(checked.blocked,false,content);
    assert.equal(checked.reply,reply,content);
  }
});
test("a repeated full preference does not trigger the generic booking clarification", () => {
  const now="2026-11-23T23:20:35.826Z";
  const reply="Which date and time would you prefer? I'll have the clinic check availability 😊";
  const checked=guardAppointmentReply({hours,customerText:"29th November \n3.00 PM",reply,
    receivedAt:now,now,language:"en",requireValidPreference:true});
  assert.equal(checked.blocked,false);
  assert.equal(checked.issue.status,"valid_preference");
  assert.doesNotMatch(checked.reply,/which date and time/i);
  assert.match(checked.reply,/check your preferred date and time/);
});
test("only the genuinely missing scheduling detail is requested", () => {
  const now="2026-11-23T23:48:20Z";
  const args={hours,receivedAt:now,now,language:"en",requireValidPreference:true,reply:"I'll check"};
  assert.match(guardAppointmentReply({...args,customerText:"29 November"}).reply,/What time on that day/);
  const timeOnly=guardAppointmentReply({...args,customerText:"3.00 PM"});
  assert.match(timeOnly.reply,/Which date would suit you/);
  assert.doesNotMatch(timeOnly.reply,/date and time/);
  // A date alone does not inherit a different date's time.
  const changed=evaluateAppointmentHours({...args,customerText:"29 November",
    recentCustomerMessages:[{content:"28 November 3pm",createdAt:"2026-11-23T23:45:00Z"}]});
  assert.equal(changed.status,"valid_day");
  const unrelated=evaluateAppointmentHours({...args,customerText:"3pm",
    recentCustomerMessages:[{content:"Promotion ends 29 November",createdAt:"2026-11-23T23:45:00Z"}]});
  assert.equal(unrelated.status,"unknown");
  const future=evaluateAppointmentHours({...args,customerText:"3pm",
    recentCustomerMessages:[{content:"29 November",createdAt:"2026-11-23T23:48:30Z"}]});
  assert.equal(future.status,"unknown");
});
test("written dates still enforce Monday closures and configured treatment durations", () => {
  const now="2026-11-23T23:48:20Z";
  const args={hours,receivedAt:now,now,language:"en",requireValidPreference:true,reply:"I'll check availability"};
  assert.equal(guardAppointmentReply({...args,customerText:"30 November 3 PM"}).issue.status,"closed");
  assert.equal(guardAppointmentReply({...args,customerText:"3 PM",recentCustomerMessages:[
    {content:"30 November",createdAt:"2026-11-23T23:48:15Z"}]}).issue.status,"closed");
  assert.equal(guardAppointmentReply({...args,customerText:"29 November 5 PM",durationMinutes:150}).issue.status,"outside_hours");
  assert.equal(guardAppointmentReply({...args,customerText:"29 November 3 PM",durationMinutes:150}).blocked,false);
  const promo=guardAppointmentReply({...args,customerText:"What is the promotion price on 30 November?",reply:"Here are the current prices"});
  assert.equal(promo.issue.status,"not_appointment");
  assert.equal(promo.reply,"Here are the current prices");
});

test("written dates respect explicit weekdays, invalid dates, and past dates",()=>{
  const now="2026-11-24T01:15:00Z";
  const args={hours,receivedAt:now,now};
  assert.equal(evaluateAppointmentHours({...args,customerText:"Sunday 6 December at 3pm"}).date,"2026-12-06");
  assert.equal(evaluateAppointmentHours({...args,customerText:"Monday 7 December at 3pm"}).status,"closed");
  assert.equal(evaluateAppointmentHours({...args,customerText:"23 November 3pm"}).status,"past");
  assert.equal(evaluateAppointmentHours({...args,customerText:"31 November 3pm",recentCustomerMessages:[
    {content:"29 November 2pm",createdAt:"2026-11-24T01:14:00Z"}]}).status,"invalid_date");
  assert.equal(detectDate("1 January","2026-12-31").date,"2027-01-01");
  assert.equal(evaluateAppointmentHours({...args,customerText:"29 November 6pm"}).status,"outside_hours");
  assert.equal(evaluateAppointmentHours({...args,customerText:"29 November evening"}).status,"outside_hours");
  assert.equal(evaluateAppointmentHours({...args,customerText:"29 November 3:75 PM"}).status,"valid_day");
});
test("cancellation, superseded dates, and polite split replies are handled conservatively",()=>{
  const now="2026-11-24T01:15:00Z";
  const args={hours,receivedAt:now,now};
  const history=(...messages)=>messages.map((content,i)=>({content,createdAt:new Date(Date.parse(now)-(i+1)*10000).toISOString()}));
  assert.equal(evaluateAppointmentHours({...args,customerText:"3pm",recentCustomerMessages:history("Actually cancel the appointment","29 November")}).status,"unknown");
  assert.equal(evaluateAppointmentHours({...args,customerText:"29 November 3pm cannot"}).status,"not_appointment");
  assert.equal(evaluateAppointmentHours({...args,customerText:"29 November",recentCustomerMessages:history("28 November 2pm","29 November 3pm")}).status,"valid_day");
  assert.equal(evaluateAppointmentHours({...args,customerText:"3pm",recentCustomerMessages:history("29 November please")}).status,"valid_preference");
  assert.equal(evaluateAppointmentHours({...args,customerText:"yes please",recentCustomerMessages:history("3pm please","29 November")}).status,"valid_preference");
});
test("normal and booking-ready replies cannot repeat or invent a verified preference",()=>{
  const now="2026-11-24T01:15:00Z";
  const args={hours,receivedAt:now,now,customerText:"29 November 3pm",language:"en",durationMinutes:90};
  for(const reply of ["Which date and time would you prefer? I'll have the clinic check availability 😊",
    "I will check November 29 at 4pm for your appointment","I will check November 28 at 3pm for your appointment",
    "Would 7pm work for your appointment?","29 November\n7pm","Would 29 November at 3pm or 7pm work for your appointment?"]){
    const checked=guardAppointmentReply({...args,reply,requireValidPreference:true});
    assert.equal(checked.blocked,false,reply);
    assert.match(checked.reply,/2026-11-29, 3:00 PM/);
  }
  const normal=guardAppointmentReply({...args,reply:"Which date and time would you prefer?",requireValidPreference:false});
  assert.equal(normal.repairedPreference,true);
  assert.equal(normal.redundantClarification,true);
  assert.match(normal.reply,/2026-11-29, 3:00 PM/);
  const mixed=guardAppointmentReply({...args,customerText:"Can I visit?",reply:"Would 29 November or 30 November work for your appointment?",requireValidPreference:false});
  assert.equal(mixed.blocked,true);
  assert.equal(mixed.issue.status,"closed");
  const morning=guardAppointmentReply({...args,customerText:"Can I visit?",reply:"Would Sunday 7am work for your appointment?",requireValidPreference:false});
  assert.equal(morning.issue.status,"outside_hours");
});
test("booking-ready recovery requires a prior scheduling question and verified customer input",()=>{
  const {canRecoverBookingReady,verifiedAppointmentPreference}=require("../src/utils/appointmentHoursGuard");
  const now="2026-11-24T01:15:00Z";
  const issue=evaluateAppointmentHours({hours,customerText:"29 November 3pm",receivedAt:now,now});
  assert.equal(verifiedAppointmentPreference(issue),"2026-11-29 15:00");
  assert.equal(canRecoverBookingReady({customerText:"29 November 3pm",previousAssistantText:"Which day would be convenient for you, weekday or weekend?",issue}),true);
  assert.equal(canRecoverBookingReady({customerText:"29 November 3pm",previousAssistantText:"Here is our promotion",issue}),false);
  assert.equal(canRecoverBookingReady({customerText:"thanks",previousAssistantText:"Which day would be convenient?",issue}),false);
  assert.equal(verifiedAppointmentPreference({status:"invalid_date"}),null);
});

test("booking-ready backstop persists only independently verified customer schedule",async()=>{
  const originalHours=config.hours;
  const originalType=config.businessType;
  config.hours=hours;
  config.businessType="tcm_clinic";
  const now=new Date();
  // Select a future open date relative to the test runner's clock.
  let day=new Date(now.getTime()+7*86400000);
  while([0,1].includes(localParts(day).weekday))day=new Date(day.getTime()+86400000);
  const date=localParts(day).date;
  let updateParams=null;
  try{
    const mark=createBookingReadyOutcomeService({
      database:{async connect(){return {
        async query(sql,params){
          if(sql.includes("UPDATE contacts c"))updateParams=params;
          return {rows:[]};
        },
        release(){},
      };}},
      lockContactAlertQueue:async()=>{},
      publish(){throw Error("no update expected");},
      sendBookingReadyAlert(){throw Error("no update expected");},
    });
    const result=await mark(9294,23511,{
      details:{appointmentPreference:"Wrong day at 4pm",staffSummary:"Wrong day at 4pm"},
      customerText:date+" 3pm",receivedAt:now,durationMinutes:90,
    });
    assert.equal(updateParams[4],date+" 15:00");
    assert.equal(result.details.appointmentPreference,date+" 15:00");
    assert.match(result.details.staffSummary,/Customer preference:/);
    assert.doesNotMatch(result.details.staffSummary,/Wrong day|4pm/);
  }finally{
    config.hours=originalHours;
    config.businessType=originalType;
  }
});

test("clock extraction preserves exact minutes, corrections, and invalid syntax",()=>{
  const {parseClockPreference,verifiedAppointmentPreference}=require("../src/utils/appointmentHoursGuard");
  const now="2026-11-24T01:15:00Z";
  const args={hours,receivedAt:now,now};
  for(const [customerText,expected] of [
    ["29 November 下午3点半","2026-11-29 15:30"],
    ["29 November 3pm not possible, 4pm please","2026-11-29 16:00"],
    ["29 November 3pm but not 4pm","2026-11-29 15:00"],
    ["29 November 3pm, no actually 4pm","2026-11-29 16:00"],
    ["29 November 2.30 petang","2026-11-29 14:30"],
    ["29 November 下午1点或2点都可以","2026-11-29 13:00 or 14:00"],
  ])assert.equal(verifiedAppointmentPreference(evaluateAppointmentHours({...args,customerText})),expected,customerText);
  for(const customerText of ["29 November 14 PM","29 November 0 AM","29 November 3pm or 25:00"]){
    assert.equal(evaluateAppointmentHours({...args,customerText}).status,"valid_day",customerText);
    assert.equal(parseClockPreference(customerText).invalid,true,customerText);
  }
});
test("time windows are continuous, and feasible start windows respect duration",()=>{
  const {verifiedAppointmentPreference}=require("../src/utils/appointmentHoursGuard");
  const now="2026-11-24T01:15:00Z";
  const args={hours,receivedAt:now,now,durationMinutes:90};
  for(const customerText of ["29 November 3pm to 5pm","29 November 3 to 5pm","29 November 下午3点到5点","29 November 15:00–17:00"]){
    const result=evaluateAppointmentHours({...args,customerText});
    assert.equal(verifiedAppointmentPreference(result),"2026-11-29 15:00–17:00",customerText);
    assert.deepEqual(result.range,[900,1020],customerText);
    assert.deepEqual(result.validWindows,[[900,990]],customerText);
  }
  assert.equal(evaluateAppointmentHours({...args,customerText:"29 November 5pm to 7pm"}).status,"outside_hours");
  const alternatives=evaluateAppointmentHours({...args,customerText:"29 November 3pm or 4pm"});
  assert.equal(verifiedAppointmentPreference(alternatives),"2026-11-29 15:00 or 16:00");
  const original="I will check 29 November from 3pm to 5pm with our clinic.";
  assert.equal(guardAppointmentReply({...args,customerText:"29 November 3pm to 5pm",reply:original,requireValidPreference:true}).reply,original);
});
test("unverified booking claims and repeated scheduling questions are repaired",()=>{
  const {claimsConfirmedAppointment}=require("../src/utils/appointmentHoursGuard");
  const now="2026-11-24T01:15:00Z";
  const args={hours,receivedAt:now,now,language:"en",customerText:"29 November 3pm"};
  for(const reply of ["Your booking is confirmed for 29 November at 3pm.","Appointment confirmed for Sunday at 3pm.","See you on Sunday!","您的预约已经确认","预约成功啦","Temujanji anda telah disahkan."]){
    assert.equal(claimsConfirmedAppointment(reply),true,reply);
    const checked=guardAppointmentReply({...args,reply,requireValidPreference:true});
    assert.equal(checked.blocked,false,reply);
    assert.match(checked.reply,/check your preferred date and time/);
    assert.equal(claimsConfirmedAppointment(checked.reply),false);
  }
  for(const reply of ["I will check and confirm your appointment.","Your appointment is not confirmed yet.","I'll get back to you once confirmed."])
    assert.equal(claimsConfirmedAppointment(reply),false,reply);
  for(const reply of ["May I know when you are free?","What is your preferred date and time?","When would be convenient for you?"]){
    const checked=guardAppointmentReply({...args,reply});
    assert.equal(checked.repairedPreference,true,reply);
    assert.match(checked.reply,/2026-11-29, 3:00 PM/);
  }
  const noPreference=guardAppointmentReply({...args,customerText:"Can I visit?",reply:"Your booking is confirmed."});
  assert.equal(noPreference.blocked,true);
  assert.equal(claimsConfirmedAppointment(noPreference.reply),false);
});
test("positive offers cannot hide behind closure statements or cancelled context",()=>{
  const now="2026-11-24T01:15:00Z";
  const args={hours,receivedAt:now,now,language:"en"};
  for(const reply of ["We are closed on Monday but you can come on Monday at 3pm.",
    "Monday is closed, but you can come on Monday at 3pm."]){
    const checked=guardAppointmentReply({...args,customerText:"Can I visit?",reply});
    assert.equal(checked.blocked,true,reply);
    assert.equal(checked.issue.status,"closed",reply);
  }
  const valid="We are closed on Monday, but Tuesday at 3pm works for your appointment.";
  assert.equal(guardAppointmentReply({...args,customerText:"Can I visit?",reply:valid}).reply,valid);
  const result=evaluateAppointmentHours({...args,customerText:"3pm",recentCustomerMessages:[
    {content:"I have decided not to proceed",createdAt:"2026-11-24T01:14:50Z"},
    {content:"29 November",createdAt:"2026-11-24T01:14:40Z"}]});
  assert.equal(result.status,"unknown");
});
test("verified staff recap retains customer-authored non-scheduling context",()=>{
  const {appointmentCustomerContext}=require("../src/utils/appointmentHoursGuard");
  const now="2026-11-24T01:15:00Z";
  const result=appointmentCustomerContext({customerText:"3pm",receivedAt:now,now,recentCustomerMessages:[
    {content:"29 November",createdAt:"2026-11-24T01:14:50Z"},
    {content:"My lower back feels stiff and I want to improve my posture.",createdAt:"2026-11-24T01:14:40Z"},
    {content:"I am interested in Package A.",createdAt:"2026-11-24T01:14:30Z"},
    {content:"My old booking was 28 November at 4pm.",createdAt:"2026-11-24T01:14:20Z"},
  ]});
  assert.deepEqual(result,["I am interested in Package A.","My lower back feels stiff and I want to improve my posture."]);
});

test("QQ: a customer-selected future date survives a three-day staff scheduling gap",()=>{
  const prior={content:"不是说了5/12",createdAt:"2026-11-22T03:12:06.682Z"};
  const staff={content:"Hi dear 5/12- 1 pm 可以吗☺️",createdAt:"2026-11-22T06:42:01.186Z"};
  const now="2026-11-25T11:47:45.684Z";
  const args={hours,receivedAt:now,now,durationMinutes:90,
    recentCustomerMessages:[prior],recentStaffMessages:[staff],requireValidPreference:true};
  const first=guardAppointmentReply({...args,customerText:"3pm ok ma",
    reply:"请问您哪一天方便呢？我帮您向诊所确认空档哦☺️"});
  assert.equal(first.blocked,false);
  assert.equal(first.issue.date,"2026-12-05");
  assert.deepEqual(first.issue.times,[900]);
  assert.match(first.reply,/2026-12-05 3:00 PM/);
  const {canRecoverBookingReady,verifiedAppointmentPreference}=require("../src/utils/appointmentHoursGuard");
  assert.equal(canRecoverBookingReady({customerText:"3pm ok ma",previousAssistantText:staff.content,issue:first.issue}),true);
  const later="2026-11-25T11:50:27.356Z";
  const second=guardAppointmentReply({...args,receivedAt:later,now:later,customerText:"5号噢",
    recentCustomerMessages:[{content:"3pm ok ma",createdAt:now},prior],
    reply:"请问您想预约哪一天、几点呢？我帮您向诊所确认空档哦☺️"});
  assert.equal(second.blocked,false);
  assert.equal(verifiedAppointmentPreference(second.issue),"2026-12-05 15:00");
  assert.doesNotMatch(second.reply,/哪一天|几点/);
});
test("cross-day model interpretation requires independent customer evidence and respects conflicts",()=>{
  const now="2026-11-25T11:47:45Z";
  const prior={content:"5/12",createdAt:"2026-11-22T03:12:06Z"};
  const args={hours,customerText:"3pm ok ma",receivedAt:now,now,durationMinutes:90};
  const old={recentCustomerMessages:[prior],appointmentPreference:"2026-12-05 15:00"};
  assert.equal(evaluateAppointmentHours({...args,...old}).status,"valid_preference");
  assert.equal(evaluateAppointmentHours({...args,appointmentPreference:old.appointmentPreference}).status,"unknown");
  assert.equal(evaluateAppointmentHours({...args,recentCustomerMessages:[prior]}).status,"unknown");
  assert.equal(evaluateAppointmentHours({...args,...old,customerText:"6号噢"}).status,"unknown");
  assert.equal(evaluateAppointmentHours({...args,...old,recentCustomerMessages:[
    {content:"6号噢",createdAt:"2026-11-25T10:00:00Z"},prior]}).status,"unknown");
  assert.equal(evaluateAppointmentHours({...args,...old,recentCustomerMessages:[
    {content:"Actually cancel the appointment",createdAt:"2026-11-23T03:12:06Z"},prior]}).status,"unknown");
  assert.equal(evaluateAppointmentHours({...args,...old,recentCustomerMessages:[
    {content:"Promotion ends 5/12",createdAt:prior.createdAt}]}).status,"unknown");
  assert.equal(evaluateAppointmentHours({...args,...old,customerText:"5号噢",recentCustomerMessages:[]}).status,"unknown");
  assert.equal(evaluateAppointmentHours({...args,...old,customerText:"7pm"}).status,"outside_hours");
  assert.equal(evaluateAppointmentHours({...args,appointmentPreference:"2026-11-30 15:00",
    recentCustomerMessages:[{content:"30/11",createdAt:prior.createdAt}]}).status,"closed");
  assert.equal(evaluateAppointmentHours({...args,...old,recentCustomerMessages:[
    {content:"5/12",createdAt:"2026-11-26T03:12:06Z"}]}).status,"unknown");
  assert.equal(evaluateAppointmentHours({...args,...old,customerText:"5号噢",
    recentCustomerMessages:[{content:"3pm",createdAt:"2026-11-23T03:12:06Z"},prior]}).status,"valid_day");
});

test("QQ: CRM backstop independently verifies the same cross-day preference",async()=>{
  const originalHours=config.hours,originalType=config.businessType;
  config.hours=hours;config.businessType="tcm_clinic";
  const now="2026-11-25T11:50:27.356Z";
  let params=null;
  try{
    const mark=createBookingReadyOutcomeService({
      database:{async connect(){return {
        async query(sql,values){if(sql.includes("UPDATE contacts c"))params=values;return {rows:[]};},
        release(){},
      };}},
      now:()=>new Date(now),lockContactAlertQueue:async()=>{},
      publish(){throw Error("no update expected");},
      sendBookingReadyAlert(){throw Error("no update expected");},
    });
    const result=await mark(9164,24187,{
      customerText:"5号噢",receivedAt:now,durationMinutes:90,
      details:{appointmentPreference:"2026-12-05 13:00"},
      recentCustomerMessages:[
        {content:"3pm ok ma",createdAt:"2026-11-25T11:47:45.684Z"},
        {content:"不是说了5/12",createdAt:"2026-11-22T03:12:06.682Z"},
      ],
      recentStaffMessages:[
        {content:"Hi dear 5/12- 1 pm 可以吗☺️",createdAt:"2026-11-22T06:42:01.186Z"},
      ],
    });
    assert.equal(params[4],"2026-12-05 15:00");
    assert.equal(result.details.appointmentPreference,"2026-12-05 15:00");
  }finally{config.hours=originalHours;config.businessType=originalType;}
});

test("AI-led appointment validation preserves treatment frequency and generic invitations",()=>{
  const now="2026-11-25T13:19:15Z";
  const {guardAiAppointmentReply}=require("../src/utils/appointmentHoursGuard");
  for(const [customerText,reply] of [
    ["调多少次？ 之后多久maintain 一次","建议初期每星期一次，大约4–6次，之后根据身体状况保养，方便的话可以预约评估哦😊"],
    ["多久保养一次？","每周一次，之后可以安排定期保养。"],
    ["How often should I maintain?","Start with once a week. You can book an assessment if convenient."],
    ["Berapa kerap maintain?","Biasanya seminggu sekali. Boleh datang untuk penilaian."],
  ]){
    const result=guardAiAppointmentReply({hours,customerText,reply,receivedAt:now,now,appointmentScheduling:false});
    assert.equal(result.reply,reply);
    assert.equal(result.blocked,false);
    assert.equal(result.issue.status,"not_appointment");
  }
  assert.equal(detectDate("每星期一次", "2026-11-25"),null);
  assert.equal(detectDate("每周1次", "2026-11-25"),null);
  assert.equal(detectDate("下星期一下午2点", "2026-11-25").date,"2026-11-30");
});
test("AI-led appointment gate retains actual booking and unverified confirmation protection",()=>{
  const {guardAiAppointmentReply}=require("../src/utils/appointmentHoursGuard");
  const args={hours,receivedAt:monday,now:laterMonday,language:"en"};
  const proposal=guardAiAppointmentReply({...args,appointmentScheduling:true,customerText:"Can I visit next week?",appointmentProposal:"Monday 2pm",reply:"Would Monday afternoon 2pm work for you?"});
  assert.equal(proposal.blocked,true);
  assert.equal(proposal.issue.status,"closed");
  const inconsistent=guardAiAppointmentReply({...args,appointmentScheduling:false,requireValidPreference:true,customerText:"How often?",reply:"Once a week."});
  assert.equal(inconsistent.blocked,true);
  assert.equal(inconsistent.reply,"Once a week.");
  const falseConfirmation=guardAiAppointmentReply({...args,appointmentScheduling:false,reply:"Your appointment is confirmed."});
  assert.equal(falseConfirmation.blocked,true);
  assert.equal(falseConfirmation.issue.status,"unverified_confirmation");
  const actualBooking=guardAiAppointmentReply({...args,appointmentScheduling:true,requireValidPreference:true,customerText:"Tuesday 2pm",appointmentPreference:"2026-11-24 14:00",reply:"I'll check Tuesday 2pm with the clinic."});
  assert.equal(actualBooking.blocked,false);
  assert.equal(actualBooking.issue.status,"valid_preference");
});

test("AI-led appointment guard does not mistake opening hours for appointment times",()=>{
  const {guardAiAppointmentReply}=require("../src/utils/appointmentHoursGuard");
  const now="2026-11-25T23:55:25Z";
  for(const customerText of ["如果今天呢","这个星期四","What about today?","Hari ini boleh?"]){
    for(const reply of ["今天是星期四，我们营业时间是早上10点到晚上8点，您想安排几点过来呢？","Today we open at 10am and close at 8pm. What time would suit you?","Hari ini buka pukul 10am hingga 8pm. Pukul berapa sesuai?"]){
      const result=guardAiAppointmentReply({hours,customerText,reply,receivedAt:now,now,appointmentScheduling:true,appointmentProposal:null,durationMinutes:135});
      assert.equal(result.reply,reply,customerText);
      assert.equal(result.blocked,false);
      assert.equal(result.issue.status,"valid_day");
    }
  }
});
test("AI-led appointment guard validates structured proposals and actual customer requests, not opening-hour prose",()=>{
  const {guardAiAppointmentReply}=require("../src/utils/appointmentHoursGuard");
  const now="2026-11-25T23:55:25Z";
  const args={hours,now,receivedAt:now,appointmentScheduling:true,durationMinutes:135};
  const invalid=guardAiAppointmentReply({...args,customerText:"这个星期四",appointmentProposal:"2026-11-26 20:00",reply:"今晚8点可以来吗？"});
  assert.equal(invalid.blocked,true);
  assert.equal(invalid.issue.status,"outside_hours");
  assert.doesNotMatch(invalid.reply,/星期五/);
  const customer=guardAiAppointmentReply({...args,customerText:"今天早上8点",reply:"好的，我帮您确认哦"});
  assert.equal(customer.blocked,true);
  assert.equal(customer.issue.status,"outside_hours");
  assert.doesNotMatch(customer.reply,/星期五/);
  const valid=guardAiAppointmentReply({...args,customerText:"今天下午3点",appointmentPreference:"2026-11-26 15:00",requireValidPreference:true,reply:"好的，我帮您确认今天下午3点的空档哦"});
  assert.equal(valid.blocked,false);
  assert.equal(valid.issue.status,"valid_preference");
  const incomplete=guardAiAppointmentReply({...args,customerText:"这个星期四",requireValidPreference:true,reply:"好的"});
  assert.equal(incomplete.blocked,true);
  assert.equal(incomplete.issue.status,"valid_day");
});
