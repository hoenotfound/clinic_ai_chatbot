"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const {
  localParts, detectDate, evaluateAppointmentHours, guardAppointmentReply,
  durationMinutesForPackage, currentClinicDate,
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
