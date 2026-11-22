"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config/clinicConfig");
const { assessmentFirstInvitation, ensureFirstAssessmentInvitation } =
  require("../src/utils/initialOfferReplyGuard");
const { buildSystemPrompt, buildFollowUpPrompt } =
  require("../src/utils/systemPrompt");

const services = [
  { name: "骨盆调理" },
  { name: "徒手体态调理" },
  { name: "3D 小颜术" },
  { name: "9D 逆龄抗衰" },
];

test("pelvic value-first invitation describes verified free intro, not Package A AI scan", () => {
  const saved = config.automatedFollowUp;
  try {
    config.automatedFollowUp = {
      ...saved, complimentaryAssessmentExperienceEnabled: true,
    };
    const reply = assessmentFirstInvitation({
      treatment: "骨盆调理", customerText: "我想了解骨盆调理",
      language: "zh", services,
    });
    assert.match(reply, /免费1对1的体态评估 \+ 体验/u);
    assert.match(reply, /中医师.*体态和身体困扰/u);
    assert.match(reply, /RM100.*优惠券/u);
    assert.match(reply, /哪一天比较方便.*确认预约时间/u);
    assert.doesNotMatch(reply, /AI\s*身体检测|已预约|保证有效|免费全套/u);
  } finally {
    config.automatedFollowUp = saved;
  }
});

test("facial assessment is specific to face and never becomes a free body intro", () => {
  for (const treatment of ["3D 小颜术", "9D 逆龄抗衰"]) {
    for (const language of ["zh", "en", "ms"]) {
      const reply = assessmentFirstInvitation({
        treatment, customerText: treatment, language, services,
      });
      assert.match(reply, /评估|assessment|penilaian/iu);
      assert.doesNotMatch(reply, /免费|percuma|complimentary|体态评估|AI\s*身体检测|RM100/u);
      assert.doesNotMatch(reply, /confirmed|已确认|已预约/iu);
    }
  }
});

test("a first-reply discovery question stays the only question after added value", () => {
  const saved = config.automatedFollowUp;
  try {
    config.automatedFollowUp = {
      ...saved, complimentaryAssessmentExperienceEnabled: true,
    };
    const guarded = ensureFirstAssessmentInvitation({
      isFirstMessage: true,
      customerText: "我想了解骨盆调理",
      language: "zh",
      reply: "你最想改善身体哪个部位？",
      treatment: "骨盆调理",
      serviceQuery: true,
      services,
    });
    assert.equal(guarded.appended, true);
    assert.match(guarded.reply, /免费1对1的体态评估/u);
    assert.equal((guarded.reply.match(/？/gu) || []).length, 1);
    assert.doesNotMatch(guarded.reply, /AI\s*身体检测/u);
  } finally {
    config.automatedFollowUp = saved;
  }
});

test("appointment prompts retain answers-first, date continuity, and no false booking", () => {
  const prompt = buildSystemPrompt({ channel: "whatsapp" });
  assert.match(prompt, /Resolve the customer's CURRENT concrete question BEFORE proposing a booking/u);
  assert.match(prompt, /Do NOT claim an appointment is booked before staff or system confirmation/u);
  const followup = buildFollowUpPrompt({ followUpContext: { stepNumber: 3 } });
  assert.match(followup, /If the customer already answered 'weekday', 'weekend'/u);
  assert.match(followup, /Do not repeat an earlier automated follow-up/u);
  assert.match(followup, /Never invent or guess prices, promotions, availability/u);
  const source = require("node:fs").readFileSync(require("node:path").join(__dirname, "../src/utils/systemPrompt.js"), "utf8");
  assert.match(source, /NEUTRO ASSESSMENT VALUE FIRST/u);
  assert.match(source, /NEUTRO VALUE-FIRST INVITATION/u);
});

test("Neutro first-session result questions lead with verified visual example, not guarantees", () => {
  const old = {
    businessType: config.businessType,
    businessName: config.businessName,
    clinicName: config.clinicName,
  };
  try {
    config.businessType = "tcm_clinic";
    config.businessName = "Neutro Sense TCM Centre";
    config.clinicName = "Neutro Sense TCM Centre";

    for (const channel of ["whatsapp", "facebook", "instagram"]) {
      const prompt = buildSystemPrompt({
        channel,
        conversationContext: {
          currentCustomerText: "一次就这样的效果？",
          relevantServiceNames: ["骨盆调理"],
        },
      });
      assert.match(prompt, /NEUTRO FIRST-SESSION RESULT QUESTIONS/u);
      assert.match(prompt, /是的☺️ 从这位顾客的 Before & After 可以看到/u);
      assert.match(prompt, /不过每个人的基础体态和实际变化都不一样/u);
      assert.match(prompt, /If one-session timing was not verified/u);
      assert.match(prompt, /do not set priceQuery\/packageQuery/u);
      assert.match(prompt, /practitioner-review rules unchanged/u);
    }

    config.businessName = "Another TCM Centre";
    assert.doesNotMatch(buildSystemPrompt({ channel: "whatsapp" }), /NEUTRO FIRST-SESSION RESULT QUESTIONS/u);
    config.businessType = "generic";
    config.businessName = "Neutro Sense TCM Centre";
    assert.doesNotMatch(buildSystemPrompt({ channel: "whatsapp" }), /NEUTRO FIRST-SESSION RESULT QUESTIONS/u);
  } finally {
    Object.assign(config, old);
  }
});
