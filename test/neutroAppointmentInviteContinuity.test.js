"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const config = require("../src/config/clinicConfig");
const {
  adaptNeutroAppointmentInvitation, customerTiming,
} = require("../src/utils/appointmentInviteContinuity");
const {
  ensureFirstAssessmentInvitation,
} = require("../src/utils/initialOfferReplyGuard");
const {
  isSchedulingNudge, repeatsSchedulingNudge, followUpCopyViolation,
} = require("../src/services/followUpAiService");
const {
  buildSystemPrompt, buildFollowUpPrompt,
} = require("../src/utils/systemPrompt");

const neutro = { businessName: "Neutro Sense TCM Centre", businessType: "tcm_clinic" };
const replyZh = "我们可以安排中医师1对1评估与咨询，让你更了解自己的身体状况 ❤️\n你下星期哪一天比较方便来呢？我帮你向门店确认时间～";
const replyEn = "If you're still considering pelvic care, our TCM practitioner can assess your concerns through a 1-on-1 assessment to suggest suitable care 😊\nWhich day next week suits you? I'll check with the clinic.";
const replyMs = "Kami boleh aturkan penilaian 1-ke-1 supaya pengamal TCM faham keadaan badan anda 😊\nHari apa minggu depan yang sesuai? Saya semak dengan pusat.";

test("long English and Malay booking questions are still repeatable scheduling nudges", () => {
  const longEnglish = "We can arrange a 1-on-1 assessment to better understand your body and posture concerns before discussing suitable care with the TCM practitioner, so that you can understand what the assessment is for and choose the right next step for you 😊\nWhich day next week suits you? I'll check with the clinic.";
  assert.ok(longEnglish.length > 240);
  assert.equal(isSchedulingNudge(longEnglish), true);
  assert.equal(isSchedulingNudge(replyMs), true);
  assert.equal(isSchedulingNudge(replyZh), true);
  const older = [{ role: "user", content: "I'm interested in pelvic assessment" },
    { role: "assistant", content: "Which day next week would suit you to visit? I can check a slot." }];
  assert.equal(repeatsSchedulingNudge(longEnglish, older.slice(1).map(x => x.content)), true);
  assert.equal(followUpCopyViolation(longEnglish, older), "repeated_scheduling_nudge");
  assert.equal(followUpCopyViolation(longEnglish,
    [...older, { role: "user", content: "Next Wednesday is good, what time can I come?" }]), null);
  assert.equal(isSchedulingNudge("The treatment can take up to two hours, and the practitioner will review your concerns first."), false);
});

test("Neutro 20-hour Chinese invitation asks only for missing time when day already supplied", () => {
  const result = adaptNeutroAppointmentInvitation({
    message: replyZh, customerTexts: ["我想问骨盆调理", "下星期三有空"],
    language: "zh", businessConfig: neutro,
  });
  assert.match(result, /体况|身体状况/u);
  assert.match(result, /你提到的那一天，大概几点比较方便/u);
  assert.doesNotMatch(result, /下星期哪一天/u);
  assert.equal((result.match(/？/gu) || []).length, 1);
  assert.doesNotMatch(result, /已经预约|已确认预约/u);
});

test("customer day and time become a slot check, not another appointment question", () => {
  for (const [message, customerTexts, language, datePattern] of [
    [replyZh, ["下星期五下午3点可以来"], "zh", /确认是否有预约名额/u],
    [replyEn, ["Next Wednesday 3pm works for me"], "en", /check the day and time you mentioned/iu],
    [replyMs, ["Saya boleh datang hari Rabu pukul 3pm"], "ms", /semak hari dan masa/iu],
  ]) {
    const reply = adaptNeutroAppointmentInvitation({
      message, customerTexts, language, businessConfig: neutro,
    });
    assert.match(reply, datePattern);
    assert.doesNotMatch(reply, /Which day next week|Hari apa minggu depan|下星期哪一天/iu);
    assert.doesNotMatch(reply, /appointment is booked|已预约成功|confirmed your booking/iu);
  }
});

test("a week-only preference keeps one question about which day, and no made-up date", () => {
  const en = adaptNeutroAppointmentInvitation({
    message: replyEn, customerTexts: ["Next week works for me"],
    language: "en", businessConfig: neutro,
  });
  assert.match(en, /Which day in the week you mentioned/u);
  const ms = adaptNeutroAppointmentInvitation({
    message: replyMs, customerTexts: ["minggu depan boleh"],
    language: "ms", businessConfig: neutro,
  });
  assert.match(ms, /Dalam minggu yang anda sebut/u);
  assert.deepEqual(customerTiming(["星期三"]), {day:true,week:false,generalDay:false,time:false});
  assert.deepEqual(customerTiming(["周末"]), {day:false,week:false,generalDay:true,time:false});
});

test("newer customer preference takes priority and reminders never change unrelated content", () => {
  const changed = adaptNeutroAppointmentInvitation({
    message: replyZh, customerTexts: ["星期三", "我星期五有空"],
    language: "zh", businessConfig: neutro,
  });
  assert.match(changed, /你提到的那一天/u);
  const otherClinic = { businessName: "Beleco Clinic", businessType: "aesthetic_clinic" };
  assert.equal(adaptNeutroAppointmentInvitation({
    message: replyEn, customerTexts: ["Next Wednesday"],
    language: "en", businessConfig: otherClinic,
  }), replyEn);
  const price = "Pelvic Package A RM388 and Package B RM268. Which price do you want to know?";
  assert.equal(adaptNeutroAppointmentInvitation({
    message: price, customerTexts: ["Next Wednesday"],
    language: "en", businessConfig: neutro,
  }), price);
  assert.equal(adaptNeutroAppointmentInvitation({
    message: replyZh, customerTexts: ["请问这星期你们营业吗？"],
    language: "zh", businessConfig: neutro,
  }), replyZh);
});

test("existing Neutro 1-to-1 invitation gains benefit before booking question, without repeated question", () => {
  const previous = { businessName: config.businessName, businessType: config.businessType,
    clinicName: config.clinicName };
  try {
    Object.assign(config, neutro);
    const oldReply = "骨盆调理主要看你的体态。\n可以先安排1对1体态评估，你比较方便平日还是周末呢？";
    const revised = ensureFirstAssessmentInvitation({
      isFirstMessage: true, customerText: "我想了解骨盆调理",
      reply: oldReply, language: "zh", treatment: "骨盆调理",
      services: [{name:"骨盆调理"}],
    });
    assert.equal(revised.appended, true);
    assert.match(revised.reply, /中医师会先了解你的体态和身体困扰/u);
    assert.ok(revised.reply.indexOf("中医师会先了解") < revised.reply.indexOf("你比较方便"));
    assert.match(revised.reply, /RM100.*优惠券/u);
    assert.equal((revised.reply.match(/？/gu) || []).length, 1);
    assert.doesNotMatch(revised.reply, /AI 身体检测|已确认预约/u);

    const rich = ensureFirstAssessmentInvitation({
      isFirstMessage: true, customerText: "我想了解3D 小颜术",
      reply: "我们可安排中医师1对1脸部评估，先了解你的脸型困扰，再决定适合什么护理。你哪一天方便呢？",
      language: "zh", treatment: "3D 小颜术", services:[{name:"3D 小颜术"}],
    });
    assert.equal(rich.appended, false, "already useful answer should not be doubled");
    assert.doesNotMatch(rich.reply, /体态评估|免费骨盆/u);

    const price = ensureFirstAssessmentInvitation({
      isFirstMessage: true, customerText: "骨盆调理多少钱？",
      reply: "Package A RM388", language: "zh", treatment: "骨盆调理",
      services:[{name:"骨盆调理"}],
    });
    assert.equal(price.appended, false);
    assert.equal(price.reply, "Package A RM388");
  } finally {
    Object.assign(config, previous);
  }
});

test("real Neutro prompt includes value-first rules and preserves pricing and confirmed-slot boundaries", () => {
  const previous = { businessName: config.businessName, businessType: config.businessType,
    clinicName: config.clinicName, messagingStyle: config.messagingStyle };
  try {
    Object.assign(config, neutro);
    config.messagingStyle = [
      "APPOINTMENT VALUE-FIRST (NEUTRO)",
      "Explain 1对1体态评估 + 入门体验 before asking for a suitable day; do not promise free AI 身体检测.",
    ].join("\n");
    const systemPrompt = buildSystemPrompt({channel:"whatsapp"});
    const followupPrompt = buildFollowUpPrompt({followUpContext:{stepNumber:3}});
    assert.match(systemPrompt, /APPOINTMENT VALUE-FIRST/u);
    assert.match(systemPrompt, /Resolve the customer's CURRENT concrete question BEFORE proposing a booking/u);
    assert.match(systemPrompt, /AI 身体检测/u);
    assert.match(systemPrompt, /Do NOT claim an appointment is booked before staff or system confirmation/u);
    assert.match(followupPrompt, /APPOINTMENT VALUE-FIRST/u);
    assert.match(followupPrompt, /Do not repeat an earlier automated follow-up/u);
  } finally {
    Object.assign(config, previous);
  }
});

test("both sender paths perform date-continuity rewrite after AI/fallback selection, not on media or price", () => {
  const primary = fs.readFileSync(path.join(__dirname, "../src/services/followUpService.js"), "utf8");
  const secondary = fs.readFileSync(path.join(__dirname, "../src/services/whatsappSecondaryFollowUpService.js"), "utf8");
  assert.match(primary, /if \(stepIndex === 3\)[\s\S]*?adaptNeutroAppointmentInvitation\(/u);
  assert.match(secondary, /if\(slot===20\)[\s\S]*?adaptNeutroAppointmentInvitation\(/u);
  assert.match(primary, /enforceAssessmentFirstFollowUpCopy/u);
  assert.match(secondary, /if\(!await preSendCheck\(\)\)/u);
  assert.match(primary, /recent_inbound_messages \|\| \[\]\)\]\.reverse\(\)/u);
  assert.match(secondary, /customer_texts\|\|\[\]\)\]\.reverse\(\)/u);
});

test("single-line natural explanation survives a separate booking question", () => {
  const message = "Our practitioner will first understand your concerns through a 1-on-1 assessment. Which day next week suits you? I'll check with the clinic.";
  const revised = adaptNeutroAppointmentInvitation({message, customerTexts:["Next Wednesday"], language:"en",businessConfig:neutro});
  assert.match(revised,/Our practitioner will first understand your concerns through a 1-on-1 assessment\./u);
  assert.match(revised,/What time on the day you mentioned/u);
  const inseparable = "We can arrange an assessment, which day suits you?";
  assert.equal(adaptNeutroAppointmentInvitation({message:inseparable,customerTexts:["Next Wednesday"],language:"en",businessConfig:neutro}),inseparable);
});
