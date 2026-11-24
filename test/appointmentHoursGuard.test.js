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
      publish(){throw Error("must not publish");},
      sendBookingReadyAlert(){alerts++;throw Error("must not alert");},
    });
    const result=await mark(9283,23208,{
      details:{appointmentPreference:"今天 下午1点或2点"},
      customerText:"下午1点或2点都可以",
      recentCustomerMessages:[{content:"今天可以吗",createdAt:monday}],
      receivedAt:monday,
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
